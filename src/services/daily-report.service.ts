// 🔻 TASK-737 (REQ-119) — `GET /api/reports/daily`, Palm's contract. The READ: every booking of the day with its coaches, handed to the pure counters in `lib/daily-report.ts`.
// 🚫 The old `getDailyReport` in `scheduler.service.ts` is untouched (the SOM report and the day-end job read it).
import { db } from "../db";
import { countDaily, type ReportRow } from "../lib/daily-report";

/**
 * Rows: every booking whose `date` is the day (a plain `date` column — no timezone conversion), `pending_slot = false`, and **`group_id IS NULL`** — a GROUP's seats are COURSE_PACKAGE
 * rows UNDER the group row and must never count anywhere (the group row itself counts once per coach). PAUSED rows ARE read: they keep their date (Awaiting). The extra coaches come from
 * `booking_teachers` (an ECA/OTHER row with several coaches counts for every one of them).
 */
export async function getDailyReportContract(date: string, teacherId?: string) {
  const found = await db.query.bookings.findMany({
    columns: { status: true, bookingType: true, teacherId: true },
    where: (b: any, { and, eq, isNull }: any) => and(eq(b.date, date), eq(b.pendingSlot, false), isNull(b.groupId)),
    with: { additionalTeachers: { columns: { teacherId: true } } },
  });
  const rows: ReportRow[] = found.map((b: any) => ({
    status: b.status,
    bookingType: b.bookingType,
    coachIds: [b.teacherId, ...(b.additionalTeachers ?? []).map((a: any) => a.teacherId)],
  }));
  return { date, ...countDaily(rows, { teacherId }) };
}
