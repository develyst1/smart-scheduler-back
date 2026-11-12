// TASK-959 (REQ-5013 option B, SPEC-105) — a CLOSED DAY: the whole school is shut on a date. THE ONE reader of `closed_days` and THE refusal every placing door raises.
//
// A closed day is the school-wide twin of a coach's ADVANCE leave (`teacher-leave.ts`): it refuses NEW work on the day, the make-up search steps over it, and the classes already there are LISTED
// for a human to clear. It restores nothing, cancels nothing, and messages nobody (SPEC-105 §4.6). Re-opening is soft: the row stays (`reopened_at` / `reopened_by`), so the table is its own audit.
//
// 🔑 "Open row" = `reopened_at IS NULL`. A reopened day is history, never a block. 🚫 No second reader: every gate asks `closedDayOn` / `assertDayOpen`.
import { and, asc, gte, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { bookings, closedDays, SLOT_INACTIVE_STATUSES, students, subjects } from "../db/schema";
import { bangkokNow } from "./bangkok-time";
import { conflict } from "./http";

export const CLOSED_REASONS = ["HOLIDAY", "VENUE_CLOSED", "WEATHER", "OTHER"] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];
export const isClosedReason = (v: unknown): v is ClosedReason => typeof v === "string" && (CLOSED_REASONS as readonly string[]).includes(v);

/** The longest range one close may cover (SPEC-105 §3). */
export const MAX_CLOSED_RANGE_DAYS = 31;
/** The longest window `GET /closed-days` reads (SPEC-105 §3: `to − from ≤ 62 days`). */
export const MAX_CLOSED_LIST_SPAN_DAYS = 62;

/** SPEC-105 §3 — the Thai word for each reason; OTHER prints the admin's own note. */
const REASON_TH: Record<Exclude<ClosedReason, "OTHER">, string> = { HOLIDAY: "วันหยุด", VENUE_CLOSED: "สถานที่ปิด", WEATHER: "สภาพอากาศ" };
export const closedReasonTh = (reason: string, note?: string | null): string => (reason === "OTHER" ? (note ?? "").trim() : (REASON_TH as Record<string, string>)[reason] ?? reason);

const MONTH_TH = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
/** "2026-11-13" → "13 พ.ย." (`d MMM`, the SPEC's message shape). */
export const shortThaiDate = (iso: string): string => {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTH_TH[(m ?? 1) - 1] ?? ""}`;
};

/** The refusal on every placing door: `409 DAY_CLOSED`, next to `TEACHER_ON_LEAVE` in style. */
export const DAY_CLOSED = (date: string, reason: string, note?: string | null) =>
  conflict("DAY_CLOSED", `วันที่ ${shortThaiDate(date)} ปิดทำการ (${closedReasonTh(reason, note)}) — กรุณาเลือกวันอื่น`);

/** Pure: does a closed day block a placement dated `date`? Only today or later — never history (a back-dated write passes, as with a coach's leave). */
export const closeFires = (date: string, today: string): boolean => date >= today;

/** THE reader: the OPEN closed-day row for `date`, or null. Reads open rows only. */
export async function closedDayOn(exec: any, date: string) {
  const row = await exec.query.closedDays.findFirst({
    where: (c: any, { and: a, eq: e, isNull: nil }: any) => a(e(c.date, date), nil(c.reopenedAt)),
  });
  return row ?? null;
}

/** Refuse (`409 DAY_CLOSED`) a placement on a closed day. Today or later only; an exempt caller (a planned absence, the camp sync) simply does not call it. */
export async function assertDayOpen(exec: any, date: string, today: string = bangkokNow().date) {
  if (!closeFires(date, today)) return;
  const row = await closedDayOn(exec, date);
  if (row) throw DAY_CLOSED(date, row.reason, row.note);
}

/** The open closed dates among `dates`, as a Set: ONE query (the make-up search and the extender ask for a whole horizon at once). */
export async function openClosedDates(exec: any, dates: readonly string[]): Promise<Set<string>> {
  if (!dates.length) return new Set();
  const rows: Array<{ date: string }> = await exec.select({ date: closedDays.date }).from(closedDays).where(and(inArray(closedDays.date, [...dates]), isNull(closedDays.reopenedAt)));
  return new Set(rows.map((r) => r.date));
}

/** The live-class predicate: the slot-active statuses, read through `SLOT_INACTIVE_STATUSES` (the make-up search's own rule). A planned absence is `SICK_LEAVE`, so it is not a class and not listed. */
const liveOnDay = (dates: string[]) => and(inArray(bookings.date, dates), isNull(bookings.groupId), notInArray(bookings.status, [...SLOT_INACTIVE_STATUSES]));

export interface ClosedDayClass {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  bookingType: string;
  childName: string | null;
  childNickname: string | null;
  coChildName: string | null;
  coChildNickname: string | null;
  program: string | null;
  title: string | null;
  inCourse: boolean;
}

/**
 * The live classes on the given dates, in the SAME flat shape as a coach's `leaveDayBookings` (so the FE reuses the leave panel's rows): the child (DUO: both), the program, the title of an OTHER,
 * whether it belongs to a course. A seat (it has a `group_id`) is not listed on its own: its group row is. Ordered by date then time.
 */
export async function liveClassesOnDates(exec: any, dates: string[]): Promise<ClosedDayClass[]> {
  if (!dates.length) return [];
  return exec
    .select({
      id: bookings.id, date: bookings.date, startTime: bookings.startTime, endTime: bookings.endTime, status: bookings.status, bookingType: bookings.bookingType,
      childName: sql<string | null>`(select ${students.name} from ${students} where ${students.id} = ${bookings.studentId})`,
      childNickname: sql<string | null>`(select ${students.nickname} from ${students} where ${students.id} = ${bookings.studentId})`,
      coChildName: sql<string | null>`(select ${students.name} from ${students} where ${students.id} = ${bookings.coStudentId})`,
      coChildNickname: sql<string | null>`(select ${students.nickname} from ${students} where ${students.id} = ${bookings.coStudentId})`,
      program: sql<string | null>`(select ${subjects.name} from ${subjects} where ${subjects.id} = ${bookings.subjectId})`,
      title: bookings.otherTitle,
      inCourse: sql<boolean>`${bookings.courseId} is not null`,
    })
    .from(bookings)
    .where(liveOnDay(dates))
    .orderBy(asc(bookings.date), asc(bookings.startTime));
}

/** The open closed-day rows between two dates (inclusive), ordered by date. */
export async function openClosedRows(exec: any, from: string, to: string) {
  return exec
    .select()
    .from(closedDays)
    .where(and(gte(closedDays.date, from), lte(closedDays.date, to), isNull(closedDays.reopenedAt)))
    .orderBy(asc(closedDays.date));
}

