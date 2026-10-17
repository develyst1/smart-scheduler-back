// 🔻 TASK-737 (REQ-119) — `GET /api/reports/daily`, Palm's contract. The READ: every booking of the day with its coaches, handed to the pure counters in `lib/daily-report.ts`.
// 🚫 The old `getDailyReport` in `scheduler.service.ts` is untouched (the SOM report and the day-end job read it).
import { db } from "../db";
import { countDaily, kidsByProgram, type CampKids, type ProgramRow, type ReportRow } from "../lib/daily-report";
import { weeksForCalendar } from "./camp.service"; // 🔻 TASK-743 — the camp week's kid count of the date: THE number the calendar prints as `campKidCount` (one definition)

/**
 * Rows: every booking whose `date` is the day (a plain `date` column — no timezone conversion), `pending_slot = false`, and **`group_id IS NULL`** — a GROUP's seats are COURSE_PACKAGE
 * rows UNDER the group row and must never count anywhere (the group row itself counts once per coach). PAUSED rows ARE read: they keep their date (Awaiting). The extra coaches come from
 * `booking_teachers` (an ECA/OTHER row with several coaches counts for every one of them).
 */
export async function getDailyReportContract(date: string, teacherId?: string) {
  const found = await db.query.bookings.findMany({
    columns: { status: true, bookingType: true, teacherId: true, date: true, startTime: true, endTime: true, otherKind: true, otherTitle: true, headCount: true, otherSeriesKey: true },
    where: (b: any, { and, eq, isNull }: any) => and(eq(b.date, date), eq(b.pendingSlot, false), isNull(b.groupId)),
    with: { additionalTeachers: { columns: { teacherId: true } }, seats: { columns: { status: true } }, campWeekDay: { columns: { campWeekId: true } } }, // 🔻 743 — a GROUP's seats are its kids; a camp hour row names its week
  });
  const rows: ReportRow[] = found.map((b: any) => ({
    status: b.status,
    bookingType: b.bookingType,
    coachIds: [b.teacherId, ...(b.additionalTeachers ?? []).map((a: any) => a.teacherId)],
  }));
  // 🔻 TASK-743 (REQ-124) — «Others Program»: the children of the day's group work. A camp week's number is read ONLY when the day has a camp row.
  const programRows: ProgramRow[] = found.map((b: any, i: number) => ({
    ...rows[i]!,
    teacherId: b.teacherId, date: b.date, startTime: b.startTime, endTime: b.endTime,
    otherKind: b.otherKind ?? null, title: b.otherTitle ?? null, headCount: b.headCount ?? null, seriesKey: b.otherSeriesKey ?? null,
    campWeekId: b.campWeekDay?.campWeekId ?? null,
    seatStatuses: b.bookingType === "GROUP" ? (b.seats ?? []).map((x: any) => x.status) : null,
  }));
  let camp: CampKids = {};
  if (programRows.some((r) => r.campWeekId)) {
    const weeks = await weeksForCalendar({ start: date, end: date });
    camp = Object.fromEntries(weeks.map((w) => [w.id, { name: w.name, kids: Number(w.dayCounts?.[date] ?? 0) }]));
  }
  return { date, ...countDaily(rows, { teacherId }), kidsByProgram: kidsByProgram(programRows, { teacherId, camp }) };
}
