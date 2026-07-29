// Parent (guardian) + student management. A parent is keyed by phone and owns up
// to MAX_STUDENTS_PER_PARENT students. Used by the LINE OA parent flow (register →
// add children) and the staff endpoints (POST /students, GET /students dropdown).

import { and, asc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { parents, students } from "../db/schema";
import { badRequest } from "../lib/http";

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
export async function searchStudents(q?: string, limit = 50) {
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
    .where(q && q.trim() ? or(...studentSearchConditions(q)) : sql`true`)
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
