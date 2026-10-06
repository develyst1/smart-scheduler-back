// TASK-561 (REQ-110 item 2) — a teacher's ADVANCE leave: THE ONE answer to "is teacher T away on date D?".
//
// 🔑 The fact is RECORDED (`teacher_leave_days`, `0062`), never inferred: a cancelled `TEACHER_LEAVE` row is a side effect of
// a different act (`reportOwnLeave`), and on an empty day that act wrote nothing — Khwan's exact case. 🚫 No second definition:
// every gate reads `teacherLeaveOn`.
//
// "Advance", exactly:
//   · a leave day is RECORDED only for a date strictly AFTER today (Bangkok) — the recording act (the owner's answer pending);
//   · the block FIRES only for a booking dated today or later — `leaveFires`. A back-dated write (an import's past sessions,
//     a correction of history) never meets it: a block that rewrote history would be worse than the bug.
//
// The owner's rule: the WHOLE day, NEW bookings with THAT teacher only; bookings already there are LISTED (`leaveDayBookings`)
// for the admin to handle by hand. 🚫 Nothing here moves or cancels anything.
//
// 🔴 TASK-582 (the owner, 2026-09-30: "for FUTURE dates the new act REPLACES the old auto-cancel — leave means one thing") —
// the WRITER lives here too, so this module stays the ONLY one that touches `teacher_leave_days`. It writes that table and
// nothing else: no booking is read for writing, moved or cancelled.
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { bookings, teacherLeaveDays, teachers } from "../db/schema";
import { bangkokNow } from "./bangkok-time";
import { COURSE_LIVE_STATUSES } from "./course-plan";
import { badRequest, conflict, notFound } from "./http";
import { ownScopeWhere, teachersOfBooking } from "./own-scope";

/**
 * 🔑 TASK-582 — THE FORK, one place: a leave for a date STRICTLY AFTER today (Bangkok) is an ADVANCE leave ⇒ the new act
 * (block the day + list). Today or the past ⇒ the old act, unchanged (`reportOwnLeave` cancels that day's classes). Today is
 * NOT advance: the day has begun, its classes are about to run, and a block that only stops NEW bookings would leave the
 * families waiting for a coach who is not coming — the cancel (which tells them) is the honest act for today.
 */
export const isAdvanceLeave = (date: string, today: string = bangkokNow().date): boolean => date > today;

// 🔴 TASK-648 (QA F1, owner ruling 2026-10-04) — the ADMIN's door takes FUTURE DAYS ONLY, and the refusal lives at that route.
// 🔑 The owner's reason: a call that accepts today CANCELS that day's classes and NOTIFIES the families in the same call —
// **one wrong call is irreversible, and the customer has already seen it.** *A door the screen refuses must not stand open behind it.*
// 🚫 It is NOT inside the act, and that is binding both ways: the TEACHER's own door shares the act and must keep accepting
// today (a coach's legitimate same-day cancel), and TASK-608's invariant is that `onBehalf` decides only WHO IS TOLD, never
// WHAT HAPPENS — refusing inside the act on `onBehalf` would break it.
// 📋 DRAFT (copy is @Sober's): the sentence names what to do instead, because a refusal that only says no sends the admin back
// to the same button.
export const ADMIN_LEAVE_FUTURE_ONLY = () =>
  badRequest("บันทึกวันลาแทนครูได้เฉพาะวันถัดไปเป็นต้นไป — ถ้าต้องการยกเลิกคาบของวันนี้ กรุณาจัดการรายคาบในปฏิทิน");

/** Pure: does a recorded leave day block a booking dated `bookingDate`? Only today or later — never history. */
export const leaveFires = (bookingDate: string, today: string): boolean => bookingDate >= today;

/** THE reader. The leave row when teacher `teacherId` is away on `date` AND the block fires; else null. */
export async function teacherLeaveOn(exec: any, teacherId: string, date: string, today: string = bangkokNow().date) {
  if (!leaveFires(date, today)) return null;
  const row = await exec.query.teacherLeaveDays.findFirst({
    where: (l: any, { and: a, eq: e }: any) => a(e(l.teacherId, teacherId), e(l.date, date)),
  });
  return row ?? null;
}

/** ✅ TASK-659 (owner APPROVED 10-06, "1-5 ตามแนะนำ") — a space ALWAYS after ครู, and «วันนี้» is gone: the day is the PICKED date, not today. */
export const TEACHER_ON_LEAVE = (teacherName: string, date: string) =>
  conflict("TEACHER_ON_LEAVE", `ครู ${teacherName} ลาวันที่ ${date} — เพิ่มคาบกับครูในวันนั้นไม่ได้ กรุณาเลือกครูอื่นหรือวันอื่น`);

/**
 * A class put (back) on the calendar WITHOUT a new insert — a reviving transition (`confirm` / `attend`), a leave's Undo, a
 * child joining an existing group row — must not land on the leave day of a coach who TEACHES it (THE "whose class"
 * predicate: the primary and every additional teacher; a seat resolves to its group). Refused, in words: the Undo and the
 * revive are the moments a human is present to decide (Sober's ruling 4).
 */
export async function assertNoCoachOnLeave(exec: any, row: { id: string; date: string }) {
  for (const coach of await teachersOfBooking(exec, row.id)) {
    if (!(await teacherLeaveOn(exec, coach.id, row.date))) continue;
    const t = await exec.query.teachers.findFirst({ where: (x: any, { eq: e }: any) => e(x.id, coach.id) });
    throw TEACHER_ON_LEAVE(t?.nickname ?? "", row.date);
  }
}

/**
 * The LIST the owner asked for: that teacher's LIVE bookings on that day — as the primary or an additional teacher (THE
 * "whose class" predicate, `ownScopeWhere`), the class rows only (a seat rides its group row, as `reportOwnLeave` reads it).
 * A read: nothing is moved or cancelled.
 */
export async function leaveDayBookings(exec: any, teacherId: string, date: string) {
  return exec.select({ id: bookings.id, date: bookings.date, startTime: bookings.startTime, endTime: bookings.endTime, status: bookings.status, bookingType: bookings.bookingType })
    .from(bookings)
    .where(and(eq(bookings.date, date), isNull(bookings.groupId), inArray(bookings.status, [...COURSE_LIVE_STATUSES]), ownScopeWhere(teacherId)))
    .orderBy(bookings.startTime);
}

/**
 * 🔴 TASK-582 — THE ADVANCE-LEAVE ACT: record "teacher T is away on date D" (future only) and return that day's LIVE classes —
 * the list the owner asked for. 🚫 It cancels, moves and notifies NOTHING: the gate starts refusing NEW bookings with T that
 * day, and the classes already there stay for a human to handle. Recording the same day twice is not an error: the first
 * record stands (its reason, its author) and the list is returned again (`alreadyRecorded`).
 */
export async function recordAdvanceLeave(exec: any, teacherId: string, input: { date: string; reason: string }, actor: string | null) {
  if (!isAdvanceLeave(input.date)) throw badRequest("ลาล่วงหน้าได้เฉพาะวันหลังจากวันนี้"); // 📋 DRAFT — the fork makes this unreachable from the route
  const [row] = await exec.insert(teacherLeaveDays).values({ teacherId, date: input.date, reason: input.reason, createdBy: actor }).onConflictDoNothing().returning();
  const leave = row ?? (await exec.query.teacherLeaveDays.findFirst({ where: (l: any, { and: a, eq: e }: any) => a(e(l.teacherId, teacherId), e(l.date, input.date)) }));
  return { leave: { date: leave.date as string, reason: (leave.reason ?? null) as string | null }, alreadyRecorded: !row, bookings: await leaveDayBookings(exec, teacherId, input.date) };
}

/**
 * 🔴 TASK-582 — LIFT a recorded day (Sober: "a block that cannot be lifted is a trap"). It deletes that ONE leave row and nothing
 * else: 🚫 it restores nothing and cancels nothing — it only stops stopping new bookings. Not recorded ⇒ 404.
 */
export async function liftAdvanceLeave(exec: any, teacherId: string, date: string) {
  const gone = await exec.delete(teacherLeaveDays).where(and(eq(teacherLeaveDays.teacherId, teacherId), eq(teacherLeaveDays.date, date))).returning({ id: teacherLeaveDays.id });
  if (!gone.length) throw notFound("ไม่พบวันลาล่วงหน้านี้"); // 📋 DRAFT
  return { lifted: date };
}

/** 🔴 TASK-582 — the teacher's OWN recorded days from today on (what can still be lifted), by date. A read. */
export async function ownAdvanceLeaves(exec: any, teacherId: string, today: string = bangkokNow().date) {
  return exec.select({ date: teacherLeaveDays.date, reason: teacherLeaveDays.reason })
    .from(teacherLeaveDays)
    .where(and(eq(teacherLeaveDays.teacherId, teacherId), gte(teacherLeaveDays.date, today)))
    .orderBy(asc(teacherLeaveDays.date));
}

/**
 * 🔴 TASK-587 (a) — THE ADMIN'S LIST: every recorded leave day in [from, to], by date then coach, each with that day's LIVE classes
 * — through `leaveDayBookings`, the ONE answer to "which classes are on that teacher's leave day" (🚫 no second query). The owner:
 * the classes already booked are "listed FOR THE ADMIN to handle by hand". A read.
 */
export async function recordedLeaveDays(exec: any, from: string, to: string) {
  const days = await exec.select({ teacherId: teacherLeaveDays.teacherId, teacherName: teachers.nickname, date: teacherLeaveDays.date, reason: teacherLeaveDays.reason, createdBy: teacherLeaveDays.createdBy })
    .from(teacherLeaveDays)
    .innerJoin(teachers, eq(teachers.id, teacherLeaveDays.teacherId))
    .where(and(gte(teacherLeaveDays.date, from), lte(teacherLeaveDays.date, to)))
    .orderBy(asc(teacherLeaveDays.date), asc(teachers.nickname));
  const out = [];
  for (const d of days) out.push({ ...d, bookings: await leaveDayBookings(exec, d.teacherId, d.date) });
  return out;
}
