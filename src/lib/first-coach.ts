// 🔻 TASK-860 (REQ-120 F4) — the facts Salary's Bonus 50 / Bonus 100 lines will read, STORED here and decided nowhere: the 1st Trial a sale converted, the child's previous course / voucher, the first coach (the coach on the
// first ATTENDED session), the last whole-course teacher change, and the admin's Bonus-100 pick. F4 pays nothing and filters nothing: it records every link whatever the dates and kinds (Bonus 100 1A / 1B, A10 and the go-live cut-off
// are still open — the later Bonus line filters).
import { and, desc, eq, lte, or, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, coursePackages, vouchers } from "../db/schema";
import { ApiException, notFound } from "./http";

export const BONUS100_PICKS = ["FIRST", "LATEST", "SHARE"] as const;
export type Bonus100Pick = (typeof BONUS100_PICKS)[number];

export interface ConversionLinks { fromTrialBookingId: string | null; prevCourseId: string | null; prevVoucherId: string | null }

/** The newer of a child's latest course and latest voucher (by `created_at`; a tie goes to the course), as the `prev_*` pair — at most ONE is set. */
export function latestEntitlement(course: { id: string; createdAt: Date | string } | undefined | null, voucher: { id: string; createdAt: Date | string } | undefined | null): Pick<ConversionLinks, "prevCourseId" | "prevVoucherId"> {
  if (!course && !voucher) return { prevCourseId: null, prevVoucherId: null };
  if (course && !voucher) return { prevCourseId: course.id, prevVoucherId: null };
  if (voucher && !course) return { prevCourseId: null, prevVoucherId: voucher.id };
  return new Date(voucher!.createdAt).getTime() > new Date(course!.createdAt).getTime() ? { prevCourseId: null, prevVoucherId: voucher!.id } : { prevCourseId: course!.id, prevVoucherId: null };
}

/**
 * The links of a SALE, read INSIDE the sale's transaction and BEFORE its insert (so the new row can never link to itself): two indexed reads for the previous entitlement, one for the trial. No try/catch — a failed read fails the sale like
 * any read in that transaction. DUO links on the PRIMARY child only (the caller passes `studentId`); the co-student gets none. The previous course counts a DUO course the child is the co-student of.
 */
export async function conversionLinks(tx: any, studentId: string, today: string): Promise<ConversionLinks> {
  // the child's latest ATTENDED 1st Trial, dated on or before today, that no course or voucher references yet
  const [trial] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(
      eq(bookings.studentId, studentId), eq(bookings.bookingType, "FIRST_TRIAL"), eq(bookings.status, "ATTENDED"), lte(bookings.date, today),
      sql`not exists (select 1 from course_packages c where c.from_trial_booking_id = ${bookings.id})`,
      sql`not exists (select 1 from vouchers v where v.from_trial_booking_id = ${bookings.id})`,
    ))
    .orderBy(desc(bookings.date), desc(bookings.startTime), desc(bookings.id))
    .limit(1);
  const [course] = await tx
    .select({ id: coursePackages.id, createdAt: coursePackages.createdAt })
    .from(coursePackages)
    .where(or(eq(coursePackages.studentId, studentId), eq(coursePackages.coStudentId, studentId)))
    .orderBy(desc(coursePackages.createdAt), desc(coursePackages.id))
    .limit(1);
  const [voucher] = await tx
    .select({ id: vouchers.id, createdAt: vouchers.createdAt })
    .from(vouchers)
    .where(eq(vouchers.studentId, studentId))
    .orderBy(desc(vouchers.createdAt), desc(vouchers.id))
    .limit(1);
  return { fromTrialBookingId: trial?.id ?? null, ...latestEntitlement(course, voucher) };
}

/** The first coach of a list of ATTENDED rows: the earliest by (date, start time); a tie takes the lowest id, so the answer is deterministic. The SQL below orders the same way. null for an empty list. */
export function pickFirstCoachRow<T extends { id: string; date: string; startTime: string; teacherId: string }>(rows: readonly T[]): T | null {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}

/**
 * Day-end step (idempotent): every course and voucher with `first_teacher_id IS NULL` that has an ATTENDED booking gets the row's own `teacher_id` (the additional teachers of a row don't count) — earliest by (date, start_time), then lowest
 * id. The first night it also fills every OLD row, imports included (their first IN-SYSTEM attended row is the best fact we have; classes taught before the import are not here). A second run writes nothing.
 */
export async function stampFirstCoach(exec: any): Promise<{ courses: number; vouchers: number }> {
  const courses = await exec.execute(sql`
    update course_packages c set first_teacher_id = f.teacher_id
    from (select distinct on (course_id) course_id, teacher_id from bookings where status = 'ATTENDED' and course_id is not null order by course_id, date, start_time, id) f
    where c.id = f.course_id and c.first_teacher_id is null
    returning c.id`);
  const vouchersDone = await exec.execute(sql`
    update vouchers v set first_teacher_id = f.teacher_id
    from (select distinct on (voucher_id) voucher_id, teacher_id from bookings where status = 'ATTENDED' and voucher_id is not null order by voucher_id, date, start_time, id) f
    where v.id = f.voucher_id and v.first_teacher_id is null
    returning v.id`);
  return { courses: courses.length, vouchers: vouchersDone.length };
}

/** A WHOLE-course teacher change (TASK-838 act): some moved row had a different coach than the one the act moves the course to. A time-only act (same teacher) is not one. */
export function isWholeCourseTeacherChange(moves: ReadonlyArray<{ from: { teacherId: string } }>, newTeacherId: string): boolean {
  return moves.some((m) => m.from.teacherId !== newTeacherId);
}

/** `PUT /courses/:id/bonus100-pick` — the admin's pick between the first and the latest coach after a whole-course change. No screen yet; the codes are for the back office's later one. */
export async function setBonus100Pick(courseId: string, pick: Bonus100Pick, actor: string | null) {
  const [c] = await db
    .select({ id: coursePackages.id, coachChangedAt: coursePackages.coachChangedAt, firstTeacherId: coursePackages.firstTeacherId, latestTeacherId: coursePackages.latestTeacherId })
    .from(coursePackages)
    .where(eq(coursePackages.id, courseId));
  if (!c) throw notFound("ไม่พบคอร์ส");
  if (!c.coachChangedAt) throw new ApiException(409, "NO_COACH_CHANGE", "คอร์สนี้ยังไม่เคยเปลี่ยนครูทั้งคอร์ส");
  if (c.latestTeacherId != null && c.latestTeacherId === c.firstTeacherId) throw new ApiException(409, "SAME_COACH", "ครูคนล่าสุดคือครูคนแรก ไม่มีให้เลือก");
  const at = new Date();
  await db.update(coursePackages).set({ bonus100Pick: pick, bonus100PickBy: actor, bonus100PickAt: at }).where(eq(coursePackages.id, courseId));
  return { id: courseId, bonus100Pick: pick, bonus100PickBy: actor, bonus100PickAt: at.toISOString() };
}
