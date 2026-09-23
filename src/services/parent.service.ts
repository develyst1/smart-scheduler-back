// Parent (guardian) + student management. A parent is keyed by phone and owns up
// to MAX_STUDENTS_PER_PARENT students. Used by the LINE OA parent flow (register →
// add children) and the staff endpoints (POST /students, GET /students dropdown).

import { and, asc, count, eq, ilike, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, coursePackages, parents, students, vouchers } from "../db/schema";
import { badRequest, conflict, notFound, pgErrorCode } from "../lib/http";
import { isSuspended } from "../lib/suspend";
import { bangkokNow } from "../lib/bangkok-time";
import { COURSE_LIVE_STATUSES } from "../lib/course-plan";
import { clearFamilyLine, familyLineUserIds, familyOfLineUser } from "../lib/family-link";
import { PARENT_ARCHIVED, activeParentWhere, cascadeMarker, isParentArchived } from "../lib/parent-archive";
import { birthdayOrder, withBirthdayFilter, type BirthdayFilter } from "../lib/birth-month";
export { activeParentWhere, isParentArchived } from "../lib/parent-archive";

/** Business rule: a single phone may register at most 5 students (their children). */
export const MAX_STUDENTS_PER_PARENT = 5;

export type ParentRow = typeof parents.$inferSelect;
export type StudentRow = typeof students.$inferSelect;

/** Digits only — phone is the parent's identity, normalize before lookup/insert. */
export function normalizePhone(input: string): string {
  return (input ?? "").replace(/\D/g, "");
}

/**
 * 🔴 TASK-447 (REQ-105 §7) — is this message A PHONE NUMBER, typed on its own?
 *
 * The silence rule (AC-16) exists so an unlinked chat does not answer chatter; this is the ONE exception the
 * owner's report demands — the OA's own auto-greeting asks for a phone, and nothing in our code was listening.
 * So the test must be **tight**: only separators (space · dash · dot · brackets · a leading `+`) may keep the
 * digits company, and there must be at least nine of them — `linkFamilyByPhone`'s own floor (`phone.length < 9`
 * ⇒ `phone-invalid`) read off the SAME `normalizePhone` above, not a second rule that can drift from it.
 *
 * 🚫 Deliberately NOT "does it contain 9 digits": `สวัสดีค่ะ 0924912848`, a nickname, a date or an address stays
 * silent. A chat that types its number alone is answering a question; a chat that mentions one is talking.
 */
export function isPhoneShaped(input: string): boolean {
  const t = (input ?? "").trim();
  if (!t || !/^\+?[\d\s().-]+$/.test(t)) return false;
  return normalizePhone(t).length >= 9;
}

export async function findParentByPhone(phone: string, exec: any = db): Promise<ParentRow | null> {
  const p = normalizePhone(phone);
  if (!p) return null;
  const row = await exec.query.parents.findFirst({
    where: (x: any, { eq: e, and: a }: any) => a(e(x.phone, p), activeParentWhere()), // TASK-411 — an archived holder is invisible here
  });
  return row ?? null;
}

/** TASK-411 — does an ARCHIVED parent hold this phone? The one read that looks past the predicate — for the two refusals (Finding B). */
export async function findArchivedParentByPhone(phone: string, exec: any = db): Promise<ParentRow | null> {
  const p = normalizePhone(phone);
  if (!p) return null;
  const row = await exec.query.parents.findFirst({ where: (x: any, { eq: e, and: a, isNotNull: nn }: any) => a(e(x.phone, p), nn(x.archivedAt)) });
  return row ?? null;
}

/** TASK-411 — a write against an archived parent is refused (edit, suspend, add a student, clear/claim a LINE link). */
export async function assertParentActive(exec: any, parentId: string): Promise<void> {
  const row = await exec.query.parents.findFirst({ where: (p: any, { eq: e }: any) => e(p.id, parentId), columns: { archivedAt: true } });
  if (isParentArchived(row)) throw PARENT_ARCHIVED();
}

/**
 * 🔴 TASK-259 — the family this LINE account acts for, resolved through **`familyOfLineUser`**.
 *
 * It used to match `parents.line_user_id` directly, which meant only ONE account per family could use the bot:
 * a second parent linking overwrote that column, and the first one's `เช็คอิน` · `ลา` · `คอร์สของฉัน` stopped
 * working — with no error, because they were simply not recognised as a parent any more.
 *
 * 🔑 Changed HERE rather than at the seven call sites, so every inbound path moves together and none can be
 * missed. `familyOfLineUser` reads `family_line_links` first and **falls back to the column**, so a family that
 * has never had a link row resolves exactly as before — which is what makes this safe with no backfill.
 */
export async function findParentByLineUserId(
  lineUserId: string,
  exec: any = db,
): Promise<ParentRow | null> {
  const parentId = await familyOfLineUser(lineUserId, exec);
  if (!parentId) return null;
  const row = await exec.query.parents.findFirst({
    where: (x: any, { eq: e }: any) => e(x.id, parentId),
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
  if (await findArchivedParentByPhone(p, exec)) throw PARENT_ARCHIVED(); // TASK-411 — never a duplicate, never a silent restore
  const [row] = await exec
    .insert(parents)
    .values({ phone: p, name: opts.name ?? null, lineUserId: opts.lineUserId ?? null })
    .returning();
  return row;
}

/**
 * Link a LINE userId to a parent (idempotent). Throws if that account belongs to a different family.
 *
 * 🔴 TASK-259 — **the column is only written when it is EMPTY.** It used to be set unconditionally, so the
 * second parent to link became the family's `line_user_id` and displaced the first — which is how a father
 * silently stopped receiving anything and stopped being recognised by the bot, with no error anywhere.
 * **First linked stays primary**; every account after it lives in `family_line_links`, which is what the
 * routing now reads. `parents.line_user_id` is the family's primary account for display, not a routing fact.
 */
export async function linkParentLine(
  parentId: string,
  lineUserId: string,
  exec: any = db,
): Promise<void> {
  await assertParentActive(exec, parentId); // TASK-411 — an archived parent cannot be (re-)linked; restore first
  // 🔴 TASK-449 (REQ-105 §7) — the guard reads the COLUMN this write is about, not "whose family is this chat".
  // `findParentByLineUserId` answers the second question (links table first), so a link row written three lines
  // earlier made it answer "you" while a DIFFERENT parent row still held the column ⇒ `23505` ⇒ the webhook
  // swallowed it ⇒ the customer got silence. One fact, read from where the uniqueness actually lives.
  const owner = await exec.query.parents.findFirst({
    columns: { id: true },
    where: (p: any, { eq: e }: any) => e(p.lineUserId, lineUserId),
  });
  if (owner && owner.id !== parentId) {
    throw badRequest("LINE นี้ผูกกับผู้ปกครองรายอื่นแล้ว");
  }
  try {
    await exec
      .update(parents)
      .set({ lineUserId })
      .where(and(eq(parents.id, parentId), isNull(parents.lineUserId)));
  } catch (e) {
    // Belt and braces: three taps in one minute is a race, and a race beats any pre-check. The index's own verdict
    // becomes the SAME sentence the guard above produces — never a raw 23505 reaching a chat as silence.
    if (pgErrorCode(e) === "23505") throw badRequest("LINE นี้ผูกกับผู้ปกครองรายอื่นแล้ว");
    throw e;
  }
}

/**
 * 🔻 TASK-392 (REQ-093) — ARCHIVED children are hidden by default: this is the ONE helper behind the parent detail
 * and list, the per-parent cap, the LIFF register, the LINE webhook's kid lists and the check-in service, so the
 * default here IS the working-read rule. `includeArchived: true` only where the caller must SEE them (the parent
 * detail's `archivedStudents`, split from one read).
 */
export async function listStudentsOfParent(
  parentId: string,
  exec: any = db,
  opts: { includeArchived?: boolean } = {},
): Promise<StudentRow[]> {
  return exec
    .select()
    .from(students)
    .where(opts.includeArchived ? eq(students.parentId, parentId) : and(eq(students.parentId, parentId), isNull(students.archivedAt)))
    .orderBy(asc(students.createdAt));
}

/** TASK-392 — the archived ids, for the reads that filter by id set (`getEligibleStudents`, like `suspendedStudentIds`). */
export async function archivedStudentIds(exec: any = db): Promise<Set<string>> {
  const rows = await exec.select({ id: students.id }).from(students).where(isNotNull(students.archivedAt));
  return new Set(rows.map((r: any) => r.id as string));
}

/** TASK-392 — a write that puts a NEW session / course / voucher on an archived child is refused: the picker hides them,
 *  and a route that accepts what the picker hides is the two-writers shape. ONE helper, three call sites. */
export async function assertStudentActive(exec: any, studentId: string): Promise<void> {
  const row = await exec.query.students.findFirst({ where: (s: any, { eq: e }: any) => e(s.id, studentId) });
  if (row?.archivedAt) throw conflict("STUDENT_ARCHIVED", "นักเรียนถูกเก็บแล้ว — คืนสถานะก่อน");
}

/**
 * TASK-392 (REQ-093 shape (a)) — ARCHIVE: hidden from every working read, nothing else touched, one tap back.
 * Idempotent (the second tap is not an error). 🔴 A child with LIVE FUTURE sessions is refused with the count —
 * archiving is for mistakes; a scheduled class is not one. Live = `date >= today` (Bangkok, today included) and a
 * course-live status, any booking type. A voucher with hours left is NOT a session ahead (no date) — allowed.
 */
/**
 * TASK-411 — REQ-093's live-future count, lifted so ONE statement answers for a student OR a whole household:
 * `date >= today AND status IN COURSE_LIVE` across the ids. The parent's refusal number and the student's are the
 * same count.
 */
export async function liveFutureSessionCount(exec: any, studentIds: string[]): Promise<number> {
  if (!studentIds.length) return 0;
  const { date: today } = bangkokNow();
  const [live] = await exec
    .select({ n: count() })
    .from(bookings)
    .where(and(or(inArray(bookings.studentId, studentIds), inArray(bookings.coStudentId, studentIds)), sql`${bookings.date} >= ${today}`, inArray(bookings.status, [...COURSE_LIVE_STATUSES]))); // TASK-420 — a DUO row counts for its co-student's household too
  return Number(live?.n ?? 0);
}

/** TASK-411 — REQ-093's write, lifted: the student's own archive and the parent's cascade share it (`by` = the actor, or `parent:<id>`). */
export async function markStudentArchived(exec: any, id: string, by: string | null): Promise<StudentRow> {
  const [updated] = await exec.update(students).set({ archivedAt: new Date(), archivedBy: by }).where(eq(students.id, id)).returning();
  return updated!;
}

export async function archiveStudent(id: string, actor: string | null): Promise<StudentRow> {
  const row = await db.query.students.findFirst({ where: (s, { eq: e }) => e(s.id, id) });
  if (!row) throw notFound("ไม่พบนักเรียน");
  if (row.archivedAt) return row;
  const n = await liveFutureSessionCount(db, [id]);
  if (n > 0) throw conflict("STUDENT_HAS_LIVE_SESSIONS", `มีคาบเรียนข้างหน้า ${n} คาบ — ยกเลิก/ย้ายก่อน`);
  return markStudentArchived(db, id, actor);
}

/** TASK-392 — UN-ARCHIVE: idempotent; the 5-per-parent cap is re-asked (an archived child does not count toward it,
 *  so restoring must not silently make six); clears both columns. */
export async function unarchiveStudent(id: string): Promise<StudentRow> {
  const row = await db.query.students.findFirst({ where: (s, { eq: e }) => e(s.id, id) });
  if (!row) throw notFound("ไม่พบนักเรียน");
  if (!row.archivedAt) return row;
  if (row.parentId) await assertParentActive(db, row.parentId); // TASK-411 — restore the household first
  if (row.parentId) await assertCanAddStudent(row.parentId);
  const [updated] = await db.update(students).set({ archivedAt: null, archivedBy: null }).where(eq(students.id, id)).returning();
  return updated!;
}

/**
 * SPEC-071 / TASK-233 — the 5-per-parent cap, **extracted so it can be asked BEFORE a flow starts**.
 *
 * The LINE registration wizard walks a parent through name → birthdate → province → confirm. Discovering the
 * cap only at the write would mean three questions and then a refusal, which reads as the system being broken.
 *
 * 🔴 Extracted rather than re-implemented at the call site: a second copy of "how many is too many" is exactly
 * the kind of duplicated rule that drifts. `createStudentForParent` calls this too, so there is one definition
 * and one message.
 */
export async function assertCanAddStudent(parentId: string, exec: any = db): Promise<number> {
  const current = await listStudentsOfParent(parentId, exec);
  if (current.length >= MAX_STUDENTS_PER_PARENT) {
    throw badRequest(`เพิ่มนักเรียนได้สูงสุด ${MAX_STUDENTS_PER_PARENT} คนต่อเบอร์`);
  }
  return current.length; // the caller needs the count it already paid for — no second query
}

/** Create a student under a parent, enforcing the 5-per-parent cap. */
export async function createStudentForParent(
  parentId: string,
  input: {
    name: string;
    nickname?: string | null;
    note?: string | null;
    // Optional demographics (TASK-050) — supplied by the staff screen so a student is created complete in one
    // call. The LINE self-registration flow omits them, exactly as before.
    gender?: string | null;
    birthDate?: string | null;
    nationality?: string | null;
  },
  exec: any = db,
): Promise<{ student: StudentRow; count: number }> {
  const name = input.name?.trim();
  if (!name) throw badRequest("กรุณาระบุชื่อนักเรียน");

  await assertParentActive(exec, parentId); // TASK-411
  const existingCount = await assertCanAddStudent(parentId, exec);

  const [student] = await exec
    .insert(students)
    .values({
      name,
      nickname: input.nickname?.trim() || name,
      parentId,
      note: input.note ?? null,
      gender: input.gender ?? null,
      birthDate: input.birthDate ?? null,
      nationality: input.nationality ?? null,
    })
    .returning();

  return { student, count: existingCount + 1 };
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
      if (isParentArchived(parent)) throw PARENT_ARCHIVED(); // TASK-411
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
  // TASK-392 — ONE read, split: `students` = active (what the page works with), `archivedStudents` = the rest (the
  // "1 archived" hint + the restore toggle, without a second call).
  const all = await listStudentsOfParent(id, exec, { includeArchived: true });
  return { ...parent, students: all.filter((s) => !s.archivedAt), archivedStudents: all.filter((s) => !!s.archivedAt) };
}

/**
 * Parents with their students embedded. `q` searches the parent's name/phone **and** their students'
 * name/nickname — the phone term is only added when the query has digits (the REQ-011 rule: a non-numeric
 * query must not `ilike '%%'` its way to the whole roster).
 */
// TASK-411 — `archived = true` ⇒ ONLY the archived parents (the restore view, the students' shape); default hides them.
export async function listParents(q?: string, limit = 50, offset = 0, archived = false) {
  const term = q?.trim();
  let ids: string[] | null = null;
  const scope = archived ? isNotNull(parents.archivedAt) : activeParentWhere();

  if (term) {
    const digits = normalizePhone(term);
    const conditions = [ilike(parents.name, `%${term}%`)];
    if (digits) conditions.push(ilike(parents.phone, `%${digits}%`));
    // Parents matched directly...
    const direct = await db
      .select({ id: parents.id })
      .from(parents)
      .where(and(or(...conditions), scope));
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

  const where = ids ? and(inArray(parents.id, ids), scope) : scope; // the search's via-student ids are re-scoped here
  const rows = await db
    .select()
    .from(parents)
    .where(where)
    .orderBy(asc(parents.createdAt))
    .limit(Math.min(limit, 200))
    .offset(offset);

  const total = Number((await db.select({ n: sql<number>`count(*)` }).from(parents).where(where))[0]?.n ?? 0); // ONE where for the page and the count

  const withKids = await Promise.all(
    rows.map(async (p) => {
      const all = await listStudentsOfParent(p.id, db, { includeArchived: true }); // TASK-392: one read, split
      return { ...p, students: all.filter((s) => !s.archivedAt), archivedStudents: all.filter((s) => !!s.archivedAt) };
    }),
  );
  return { parents: withKids, total };
}

export async function getParent(id: string, opts: { archived?: boolean } = {}) {
  const row = await loadParentWithStudents(id);
  if (!row) throw notFound("ไม่พบผู้ปกครอง");
  if (isParentArchived(row) && !opts.archived) throw notFound("ไม่พบผู้ปกครอง"); // TASK-411 — the restore view asks with ?archived=1
  // SPEC-071 / TASK-243 — whether this family has a LINE account bound, and how many.
  //
  // 🔴 Read through the ONE accessor, not off `parents.line_user_id`: since TASK-230 a family can hold more
  // than one account, and the People screen must show what is actually bound BEFORE an admin clears it. That
  // screen said nothing at all until now — which is why "contact an admin" pointed at someone with no
  // information as well as no button.
  const lineAccounts = await familyLineUserIds(id);
  return { ...row, lineAccounts: lineAccounts.length, lineLinked: lineAccounts.length > 0 };
}

/**
 * SPEC-071 / TASK-243 — the staff act. Thin on purpose: the rule lives in `lib/family-link.ts`, beside the
 * binding it undoes, so the two can never drift into different ideas of what a family's accounts are.
 */
export async function clearParentLineLink(id: string, actor: string | null) {
  const parent = await db.query.parents.findFirst({ where: (p: any, { eq: e }: any) => e(p.id, id) });
  if (!parent) throw notFound("ไม่พบผู้ปกครอง");
  if (isParentArchived(parent)) throw PARENT_ARCHIVED(); // TASK-411 — already cleared by the archive
  const { cleared } = await clearFamilyLine(id, actor);
  return { cleared: cleared.length };
}

export async function createParent(input: {
  phone: string;
  name?: string | null;
  province?: string | null;
  note?: string | null;
}) {
  const phone = normalizePhone(input.phone);
  if (phone.length < 9) throw badRequest("เบอร์โทรไม่ถูกต้อง");
  if (await findParentByPhone(phone)) throw badRequest("เบอร์นี้มีผู้ปกครองในระบบแล้ว");
  if (await findArchivedParentByPhone(phone)) throw conflict("PARENT_ARCHIVED", "เบอร์นี้เป็นของผู้ปกครองที่ถูกเก็บแล้ว — คืนสถานะแทน"); // TASK-411 (Finding B)
  const [row] = await db
    .insert(parents)
    .values({
      phone,
      name: input.name ?? null,
      province: input.province ?? null,
      note: input.note ?? null,
    })
    .returning();
  return { ...row, students: [] };
}

export async function updateParent(
  id: string,
  input: { name?: string | null; phone?: string; province?: string | null; note?: string | null },
) {
  await assertParentActive(db, id); // TASK-411
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.province !== undefined) patch.province = input.province;
  if (input.note !== undefined) patch.note = input.note;
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

// ───────────── TASK-364 (REQ-089 item 3) — hard delete of a student with NO history ─────────────
//
// The ONE exception to "nothing is ever deleted; suspend is the off switch". Linking parents by LINE produced
// wrongly-created children; a child with no course, no booking and no voucher has nothing to keep, and
// suspending the whole family for it would punish the parent. "History" is a ROW in any of the three tables in
// ANY status — a cancelled booking is history; the family's suspension is not (it lives on the parent).
//
// 🔴 The database already refuses this delete (all three FKs are `onDelete: "restrict"`), but the app's
// `onError` renders SQLSTATE 23503 as `400 VALIDATION` — a validation error for a row that was refused on
// purpose. So the service refuses FIRST with a code and the counts, and when the FK fires anyway (a booking born
// between the count and the delete) it is caught HERE and re-said with the same code: the FK is the guard, the
// count is the sentence.

export type StudentHistory = { courses: number; bookings: number; vouchers: number };

/** The 409 for a student with history, or `null` when the three counts are zero. Pure — the rule in one place. */
export function studentHistoryRefusal(h: StudentHistory) {
  if (h.courses === 0 && h.bookings === 0 && h.vouchers === 0) return null;
  return conflict(
    "STUDENT_HAS_HISTORY",
    `มีประวัติ: คอร์ส ${h.courses} · คาบ ${h.bookings} · บัตร ${h.vouchers} — ระงับแทน`,
  );
}

/** Rows naming this student in the three history tables — ANY status, no filter. */
export async function countStudentHistory(studentId: string, exec: any = db): Promise<StudentHistory> {
  const rows = async (table: any) => // TASK-420 — a DUO course / row is history for its co-student too
    Number((await exec.select({ n: count() }).from(table).where(table.coStudentId ? or(eq(table.studentId, studentId), eq(table.coStudentId, studentId)) : eq(table.studentId, studentId)))[0]?.n ?? 0);
  return { courses: await rows(coursePackages), bookings: await rows(bookings), vouchers: await rows(vouchers) };
}

/**
 * `DELETE /students/:id` — count → refuse or delete, in one transaction. The parent's child count is a live
 * count (`listStudentsOfParent`), so the freed slot is visible to `assertCanAddStudent` with no bookkeeping.
 * Audit is one server log line, not a table — a table for a wrongly-created row is a soft delete by another name.
 */
export async function deleteStudent(id: string, actor: string | null): Promise<{ deleted: true }> {
  let gone: StudentRow;
  try {
    gone = await db.transaction(async (tx) => {
      const student = await tx.query.students.findFirst({ where: (s, { eq: e }) => e(s.id, id) });
      if (!student) throw notFound("ไม่พบนักเรียน");
      const refusal = studentHistoryRefusal(await countStudentHistory(id, tx));
      if (refusal) throw refusal;
      await tx.delete(students).where(eq(students.id, id));
      return student;
    });
  } catch (e) {
    if (pgErrorCode(e) !== "23503") throw e;
    // The race: history was born between the count and the delete, and the FK held. Re-count outside the
    // aborted transaction so the sentence carries the numbers; never let the raw restrict error reach `onError`.
    throw studentHistoryRefusal(await countStudentHistory(id)) ?? conflict("STUDENT_HAS_HISTORY", "มีประวัติ — ระงับแทน");
  }
  console.info(`student deleted: ${gone.id} "${gone.name}" parent=${gone.parentId ?? "walk-in"} by ${actor ?? "unknown"}`);
  return { deleted: true };
}

/** Reversible household suspend — enforced server-side (LINE bot + booking creation), never a delete. */
export async function setParentSuspended(id: string, suspended: boolean) {
  const parent = await db.query.parents.findFirst({ where: (p, { eq: e }) => e(p.id, id) });
  if (!parent) throw notFound("ไม่พบผู้ปกครอง");
  if (isParentArchived(parent)) throw PARENT_ARCHIVED(); // TASK-411 — suspend and archive coexist, but an archived row is not edited
  await db
    .update(parents)
    .set({ suspendedAt: suspended ? new Date() : null })
    .where(eq(parents.id, id));
  return getParent(id);
}

/** The household owning this student, or null for a walk-in/trial student with no parent. */
/**
 * TASK-411 (REQ-098) — archive a PARENT, ONE tx: the household's live future sessions (ONE grouped count) ⇒
 * `409 PARENT_HAS_SESSIONS`; the LINE accounts cleared through the ONE unlinker (link rows + column + rich menu —
 * `familyOfLineUser` can no longer reach the row) and kept in `archived_line_user_ids` for the audit; the three
 * columns; every NON-archived student cascaded with `archived_by = "parent:<id>"` (REQ-093's write — its own
 * refusal is the household count above). Idempotent: an archived parent ⇒ the row, no writes. The phone stays.
 */
export async function archiveParent(id: string, actor: string | null) {
  const parent = await db.query.parents.findFirst({ where: (p, { eq: e }) => e(p.id, id) });
  if (!parent) throw notFound("ไม่พบผู้ปกครอง");
  if (parent.archivedAt) return { parent: await getParent(id, { archived: true }), archivedStudents: 0, clearedLineAccounts: 0 };
  const kids = await listStudentsOfParent(id, db);
  const n = await liveFutureSessionCount(db, kids.map((s) => s.id));
  if (n > 0) throw conflict("PARENT_HAS_SESSIONS", `มีคาบเรียนในอนาคต ${n} คาบ — ยกเลิก/ย้ายก่อน`);
  const result = await db.transaction(async (tx) => {
    const { cleared } = await clearFamilyLine(id, actor, tx);
    await tx.update(parents).set({ archivedAt: new Date(), archivedBy: actor, archivedLineUserIds: cleared }).where(eq(parents.id, id));
    for (const s of kids) await markStudentArchived(tx, s.id, cascadeMarker(id));
    return { archivedStudents: kids.length, clearedLineAccounts: cleared.length };
  });
  return { parent: await getParent(id, { archived: true }), ...result };
}

/**
 * TASK-411 — restore: the parent's three columns cleared (the LINE accounts are NOT put back — the family re-links;
 * the audit list stays), and ONLY the students this parent's archive cascaded (`archived_by = "parent:<id>"`) come
 * back — a student archived on its own is untouched. No household-cap check: they were the household before.
 */
export async function unarchiveParent(id: string) {
  const parent = await db.query.parents.findFirst({ where: (p, { eq: e }) => e(p.id, id) });
  if (!parent) throw notFound("ไม่พบผู้ปกครอง");
  if (!parent.archivedAt) return { parent: await getParent(id), restoredStudents: 0 };
  const restored = await db.transaction(async (tx) => {
    await tx.update(parents).set({ archivedAt: null, archivedBy: null }).where(eq(parents.id, id));
    const rows = await tx.update(students).set({ archivedAt: null, archivedBy: null }).where(and(eq(students.parentId, id), eq(students.archivedBy, cascadeMarker(id)))).returning({ id: students.id });
    return rows.length;
  });
  return { parent: await getParent(id), restoredStudents: restored };
}

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
  return studentSearchConditionsOn(q, students, parents);
}

/** TASK-420 — the same three conditions on an ALIASED pair (the course list matches a DUO course's co-student too). */
export function studentSearchConditionsOn(q: string, s: typeof students, p: typeof parents) {
  const term = q.trim();
  const digits = normalizePhone(q);
  const conditions = [
    ilike(s.name, `%${term}%`),
    ilike(s.nickname, `%${term}%`),
  ];
  if (digits) conditions.push(ilike(p.phone, `%${digits}%`));
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
// 🔻 TASK-392 (REQ-093) — `archived` = false (default): ARCHIVED children are hidden — this IS the picker and the
// People page's student list. `archived = true`: ONLY the archived ones (the restore view), same rows + `archivedAt`.
// TASK-414 (REQ-099) — `birthday`: a birth-MONTH range (wraps past December) or `noDob`, COMPOSED with the search, the
// suspended exclusion and the archived default (never replacing them); a range orders from its first month around the
// year, then the day, then the name.
export async function searchStudents(q?: string, limit = 50, archived = false, birthday: BirthdayFilter = {}) {
  const excluded = [...(await suspendedStudentIds())];
  const searchWhere = and(
    q && q.trim() ? or(...studentSearchConditions(q)) : sql`true`,
    archived ? isNotNull(students.archivedAt) : isNull(students.archivedAt),
  );
  const baseWhere = excluded.length ? and(searchWhere, notInArray(students.id, excluded))! : searchWhere!;
  const rows = await db
    .select({
      id: students.id,
      name: students.name,
      nickname: students.nickname,
      parentId: students.parentId,
      phone: parents.phone,
      parentName: parents.name,
      archivedAt: students.archivedAt,
      birthDate: students.birthDate, // TASK-414
    })
    .from(students)
    .leftJoin(parents, eq(parents.id, students.parentId))
    .where(withBirthdayFilter(baseWhere, birthday))
    .orderBy(...birthdayOrder(birthday)) // TASK-416: the order follows the ONE branch decision (date · month-wrap · name)
    .limit(Math.min(limit, 200));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    nickname: r.nickname ?? null,
    phone: r.phone ?? null,
    parentId: r.parentId ?? null,
    parentName: r.parentName ?? null,
    label: r.phone ? `${r.name} (${r.phone})` : r.name,
    archivedAt: r.archivedAt ? new Date(r.archivedAt).toISOString() : null, // TASK-392
    birthDate: r.birthDate ?? null, // TASK-414 — ISO YYYY-MM-DD | null (the FE renders DD-MM-YYYY or —)
  }));
}
