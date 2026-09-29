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
import { and, eq, inArray, isNull } from "drizzle-orm";
import { bookings } from "../db/schema";
import { bangkokNow } from "./bangkok-time";
import { COURSE_LIVE_STATUSES } from "./course-plan";
import { conflict } from "./http";
import { ownScopeWhere, teachersOfBooking } from "./own-scope";

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

/** 📋 DRAFT wording (owner's copy batch), pinned by shape: who, which day, and what to do instead. */
export const TEACHER_ON_LEAVE = (teacherName: string, date: string) =>
  conflict("TEACHER_ON_LEAVE", `ครู${teacherName} ลาวันที่ ${date} — เพิ่มคาบกับครูวันนี้ไม่ได้ กรุณาเลือกครูอื่นหรือวันอื่น`);

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
