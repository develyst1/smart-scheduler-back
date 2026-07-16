// End-of-day auto-cut job (UC-012). Triggered by a Windows Task Scheduler exe
// (see scripts/end-of-day.ts) that POSTs the internal endpoint. All logic lives
// here — the exe is a thin trigger — so it can also be run by hand or re-run.
//
// Cuts no-shows: a CONFIRMED class on the target date whose end time has passed,
// with no check-in (ATTENDED) and no leave (SICK_LEAVE), becomes NO_SHOW and its
// course/voucher quota is deducted (the student loses the session). Idempotent:
// only CONFIRMED rows are touched, so a second run cuts nothing.

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, coursePackages, jobRuns, vouchers } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";
import { getDailyReport } from "./scheduler.service";

export async function runEndOfDayJob(date?: string) {
  const now = bangkokNow();
  const runDate = date ?? now.date;

  const cut = await db.transaction(async (tx) => {
    // Which CONFIRMED classes on runDate have already ended?
    //  - past date  → all of them
    //  - today      → only those whose end time is at/behind the Bangkok clock
    //  - future     → none
    const ended =
      runDate < now.date
        ? sql`true`
        : runDate === now.date
          ? sql`${bookings.endTime} <= ${now.time}::time`
          : sql`false`;

    const due = await tx
      .select({
        id: bookings.id,
        courseId: bookings.courseId,
        voucherId: bookings.voucherId,
      })
      .from(bookings)
      .where(and(eq(bookings.date, runDate), eq(bookings.status, "CONFIRMED"), ended));

    let coursesCut = 0;
    let vouchersCut = 0;
    for (const b of due) {
      await tx.update(bookings).set({ status: "NO_SHOW" }).where(eq(bookings.id, b.id));
      if (b.courseId) {
        await tx
          .update(coursePackages)
          .set({ usedSessions: sql`${coursePackages.usedSessions} + 1` })
          .where(eq(coursePackages.id, b.courseId));
        coursesCut++;
      }
      if (b.voucherId) {
        await tx
          .update(vouchers)
          .set({ usedHours: sql`${vouchers.usedHours} + 1` })
          .where(eq(vouchers.id, b.voucherId));
        vouchersCut++;
      }
    }

    return { noShow: due.length, coursesCut, vouchersCut };
  });

  // Report is read after the cut so its counts reflect the new NO_SHOW rows.
  const report = await getDailyReport(runDate);
  const summary = { ...cut, report };

  await db.insert(jobRuns).values({
    job: "end-of-day",
    runDate,
    status: "success",
    summary,
    finishedAt: new Date(),
  });

  return { date: runDate, ranAt: now.time, ...summary };
}
