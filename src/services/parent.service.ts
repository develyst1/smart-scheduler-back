// Parent (guardian) + student management. A parent is keyed by phone and owns up
// to MAX_STUDENTS_PER_PARENT students. Used by the LINE OA parent flow (register →
// add children) and the staff endpoints (POST /students, GET /students dropdown).

import { and, asc, eq, ilike, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import { parents, students } from "../db/schema";
import { badRequest, notFound } from "../lib/http";
import { isSuspended } from "../lib/suspend";

/** Business rule: a single phone may register at most 5 students (their children). */
export const MAX_STUDENTS_PER_PARENT = 5;

export type ParentRow = typeof parents.$inferSelect;
export type StudentRow = typeof students.$inferSelect;

/** Digits only — phone is the parent's identity, normalize before lookup/insert. */
export function normalizePhone(input: string): string {
  return (input ?? "").replace(/\D/g, "");
}

export async function findParentByPhone(phone: string, exec: any = db): Promise<ParentRow | null> {
  const p = normalizePhone(phone);
  if (!p) return null;
  const row = await exec.query.parents.findFirst({
    where: (x: any, { eq: e }: any) => e(x.phone, p),
  });
  return row ?? null;
}

export async function findParentByLineUserId(
  lineUserId: string,
  exec: any = db,
): Promise<ParentRow | null> {
  const row = await exec.query.parents.findFirst({
    where: (x: any, { eq: e }: any) => e(x.lineUserId, lineUserId),
  });
  return row ?? null;
}

/** Find an existing parent by phone, or create one. Optionally link a LINE userId. */
export async function findOrCreateParentByPhone(
  phone: string,
  opts: { name?: string | null; lineUserId?: string | null } = {},
  exec: any = db,
): Promise<ParentRow> {
  const p = normalizePhone(phone);
  if (p.length < 9) throw badRequest("เบอร์โทรไม่ถูกต้อง");
  const existing = await findParentByPhone(p, exec);
  if (existing) return existing;
  const [row] = await exec
    .insert(parents)
    .values({ phone: p, name: opts.name ?? null, lineUserId: opts.lineUserId ?? null })
    .returning();
  return row;
}

/** Link a LINE userId to a parent (idempotent). Throws if the parent is linked elsewhere. */
export async function linkParentLine(
  parentId: string,
  lineUserId: string,
  exec: any = db,
): Promise<void> {
  const owner = await findParentByLineUserId(lineUserId, exec);
  if (owner && owner.id !== parentId) {
    throw badRequest("LINE นี้ผูกกับผู้ปกครองรายอื่นแล้ว");
  }
  await exec.update(parents).set({ lineUserId }).where(eq(parents.id, parentId));
}

export async function listStudentsOfParent(
  parentId: string,
  exec: any = db,
): Promise<StudentRow[]> {
  return exec
    .select()
    .from(students)
    .where(eq(students.parentId, parentId))
    .orderBy(asc(students.createdAt));
}

/** Create a student under a parent, enforcing the 5-per-parent cap. */
export async function createStudentForParent(
  parentId: string,
  input: { name: string; nickname?: string | null; note?: string | null },
  exec: any = db,
): Promise<{ student: StudentRow; count: number }> {
  const name = input.name?.trim();
  if (!name) throw badRequest("กรุณาระบุชื่อนักเรียน");

  const current = await listStudentsOfParent(parentId, exec);
  if (current.length >= MAX_STUDENTS_PER_PARENT) {
    throw badRequest(`เพิ่มนักเรียนได้สูงสุด ${MAX_STUDENTS_PER_PARENT} คนต่อเบอร์`);
  }

  const [student] = await exec
    .insert(students)
    .values({
      name,
      nickname: input.nickname?.trim() || name,
      parentId,
      note: input.note ?? null,
    })
    .returning();

  return { student, count: current.length + 1 };
}

/**
 * Staff student creation. Accepts an existing parentId OR a phone (find-or-create
 * the parent). Returns the new student plus its parent. Enforces the per-parent cap.
 */
export async function createStudent(input: {
  name: string;
  nickname?: string;
  note?: string;
  parentId?: string;
  parentPhone?: string;
  parentName?: string;
}): Promise<{ student: StudentRow; parent: ParentRow }> {
  return db.transaction(async (tx) => {
    let parent: ParentRow | null = null;
    if (input.parentId) {
      parent = (await tx.query.parents.findFirst({
        where: (x: any, { eq: e }: any) => e(x.id, input.parentId),
      })) ?? null;
      if (!parent) throw badRequest("ไม่พบผู้ปกครอง");
    } else if (input.parentPhone) {
      parent = await findOrCreateParentByPhone(
        input.parentPhone,
        { name: input.parentName ?? null },
        tx,
      );
    } else {
      throw badRequest("ต้องระบุ parentId หรือ parentPhone");
    }

    const { student } = await createStudentForParent(
      parent.id,
      { name: input.name, nickname: input.nickname, note: input.note },
      tx,
    );
    return { student, parent };
  });
}

// ───────────────────── Staff people management (REQ-019 / TASK-048) ─────────────────────
// Nothing here ever deletes: `suspend` is the only "off" switch, and it is reversible.

/** Parent + their students, the shape the `/scheduler/people` screen renders. */
async function loadParentWithStudents(id: string, exec: any = db) {
  const parent = await exec.query.parents.findFirst({
    where: (p: any, { eq: e }: any) => e(p.id, id),
  });
  if (!parent) return null;
  return { ...parent, students: await listStudentsOfParent(id, exec) };
}

/**
 * Parents with their students embedded. `q` searches the parent's name/phone **and** their students'
 * name/nickname — the phone term is only added when the query has digits (the REQ-011 rule: a non-numeric
 * query must not `ilike '%%'` its way to the whole roster).
 */
export async function listParents(q?: string, limit = 50, offset = 0) {
  const term = q?.trim();
  let ids: string[] | null = null;

  if (term) {
    const digits = normalizePhone(term);
    const conditions = [ilike(parents.name, `%${term}%`)];
    if (digits) conditions.push(ilike(parents.phone, `%${digits}%`));
    // Parents matched directly...
    const direct = await db
      .select({ id: parents.id })
      .from(parents)
      .where(or(...conditions));
    // ...plus parents whose STUDENT matches (staff search by the child's name).
    const viaStudent = await db
      .select({ id: students.parentId })
      .from(students)
      .where(
        and(
          isNotNull(students.parentId),
          or(ilike(students.name, `%${term}%`), ilike(students.nickname, `%${term}%`)),
        ),
      );
    ids = [...new Set([...direct.map((r) => r.id), ...viaStudent.map((r) => r.id!)])];
    if (!ids.length) return { parents: [], total: 0 };
  }

  const where = ids ? inArray(parents.id, ids) : undefined;
  const rows = await db
    .select()
    .from(parents)
    .where(where)
    .orderBy(asc(parents.createdAt))
    .limit(Math.min(limit, 200))
    .offset(offset);

  // `total` is always present so the screen can paginate (a search knows its own match count).
  const total = ids
    ? ids.length
    : Number((await db.select({ n: sql<number>`count(*)` }).from(parents))[0]?.n ?? 0);

  const withKids = await Promise.all(
    rows.map(async (p) => ({ ...p, students: await listStudentsOfParent(p.id) })),
  );
  return { parents: withKids, total };
}

export async function getParent(id: string) {
  const row = await loadParentWithStudents(id);
  if (!row) throw notFound("ไม่พบผู้ปกครอง");
  return row;
}

export async function createParent(input: {
  phone: string;
  name?: string | null;
  province?: string | null;
}) {
  const phone = normalizePhone(input.phone);
  if (phone.length < 9) throw badRequest("เบอร์โทรไม่ถูกต้อง");
  if (await findParentByPhone(phone)) throw badRequest("เบอร์นี้มีผู้ปกครองในระบบแล้ว");
  const [row] = await db
    .insert(parents)
    .values({ phone, name: input.name ?? null, province: input.province ?? null })
    .returning();
  return { ...row, students: [] };
}

export async function updateParent(
  id: string,
  input: { name?: string | null; phone?: string; province?: string | null },
) {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.province !== undefined) patch.province = input.province;
  if (input.phone !== undefined) {
    const phone = normalizePhone(input.phone);
    if (phone.length < 9) throw badRequest("เบอร์โทรไม่ถูกต้อง");
    const owner = await findParentByPhone(phone);
    if (owner && owner.id !== id) throw badRequest("เบอร์นี้มีผู้ปกครองรายอื่นใช้อยู่");
    patch.phone = phone;
  }
  if (Object.keys(patch).length) {
    await db.update(parents).set(patch).where(eq(parents.id, id));
  }
  return getParent(id);
}

/** Patch a student's details/demographics. DOB is stored; age is derived at read time, never stored. */
export async function updateStudent(
  id: string,
  input: {
    name?: string;
    nickname?: string | null;
    gender?: string | null;
    birthDate?: string | null;
    nationality?: string | null;
    note?: string | null;
  },
) {
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "nickname", "gender", "birthDate", "nationality", "note"] as const) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  if (patch.name !== undefined && !String(patch.name).trim()) throw badRequest("กรุณาระบุชื่อนักเรียน");
  if (Object.keys(patch).length) {
    await db.update(students).set(patch).where(eq(students.id, id));
  }
  const row = await db.query.students.findFirst({ where: (s, { eq: e }) => e(s.id, id) });
  if (!row) throw notFound("ไม่พบนักเรียน");
  return row;
}

/** Reversible household suspend — enforced server-side (LINE bot + booking creation), never a delete. */
export async function setParentSuspended(id: string, suspended: boolean) {
  const parent = await db.query.parents.findFirst({ where: (p, { eq: e }) => e(p.id, id) });
  if (!parent) throw notFound("ไม่พบผู้ปกครอง");
  await db
    .update(parents)
    .set({ suspendedAt: suspended ? new Date() : null })
    .where(eq(parents.id, id));
  return getParent(id);
}

/** The household owning this student, or null for a walk-in/trial student with no parent. */
export async function findParentOfStudent(studentId: string, exec: any = db) {
  const student = await exec.query.students.findFirst({
    where: (s: any, { eq: e }: any) => e(s.id, studentId),
  });
  if (!student?.parentId) return null;
  return (
    (await exec.query.parents.findFirst({
      where: (p: any, { eq: e }: any) => e(p.id, student.parentId),
    })) ?? null
  );
}

/** OR-conditions for the student search WHERE. The parent-phone `ilike` is included ONLY when the query has
 *  digits — otherwise `normalizePhone(q)` is `""` and `ilike(phone, '%%')` matches every student with a phone,
 *  which defeats the name/nickname filters and returns the whole roster (REQ-011 bug). Name + nickname always
 *  match. Exported so the phone-clause rule is unit-testable without a DB. */
export function studentSearchConditions(q: string) {
  const term = q.trim();
  const digits = normalizePhone(q);
  const conditions = [
    ilike(students.name, `%${term}%`),
    ilike(students.nickname, `%${term}%`),
  ];
  if (digits) conditions.push(ilike(parents.phone, `%${digits}%`));
  return conditions;
}

/** Booking dropdown source: students searchable by name, nickname, or parent phone. */
/**
 * Ids of students belonging to a **suspended** household (REQ-019 / TASK-056). Built on
 * `lib/suspend.ts`'s `isSuspended` — one rule, shared by both booking pickers, never restated.
 *
 * ⚠️ The `innerJoin` is correct **here and only here**: this builds the set of students to EXCLUDE, so a
 * student with no parent (walk-in / First-Trial — `students.parent_id` is nullable by design) simply isn't in
 * it and therefore **stays visible**. Do not "fix" this to a LEFT join.
 */
export async function suspendedStudentIds(exec: any = db): Promise<Set<string>> {
  const rows = await exec
    .select({ id: students.id, suspendedAt: parents.suspendedAt })
    .from(students)
    .innerJoin(parents, eq(parents.id, students.parentId));
  return new Set(
    rows.filter((r: any) => isSuspended(r.suspendedAt)).map((r: any) => r.id as string),
  );
}

/**
 * Student-dropdown search. Suspended households are **always excluded** (TASK-058): all three consumers — the
 * booking picker and both sale modals — now want the same policy, so an opt-in flag would just mean "remember
 * to ask for it", and whoever forgot would open a silent hole. No `includeSuspended` escape hatch: the People
 * screen reads `/parents`, where suspended families stay fully visible.
 */
export async function searchStudents(q?: string, limit = 50) {
  const excluded = [...(await suspendedStudentIds())];
  const searchWhere = q && q.trim() ? or(...studentSearchConditions(q)) : sql`true`;
  const rows = await db
    .select({
      id: students.id,
      name: students.name,
      nickname: students.nickname,
      parentId: students.parentId,
      phone: parents.phone,
      parentName: parents.name,
    })
    .from(students)
    .leftJoin(parents, eq(parents.id, students.parentId))
    .where(
      excluded.length ? and(searchWhere, notInArray(students.id, excluded)) : searchWhere,
    )
    .orderBy(asc(students.name))
    .limit(Math.min(limit, 200));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    nickname: r.nickname ?? null,
    phone: r.phone ?? null,
    parentId: r.parentId ?? null,
    parentName: r.parentName ?? null,
    label: r.phone ? `${r.name} (${r.phone})` : r.name,
  }));
}
