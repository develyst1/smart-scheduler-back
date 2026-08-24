// End-of-day auto-mark job (UC-012). Triggered by a Windows Task Scheduler exe
// (see scripts/end-of-day.ts) that POSTs the internal endpoint. All logic lives
// here — the exe is a thin trigger — so it can also be run by hand or re-run.
//
// A CONFIRMED class on the target date whose end time has passed, with no check-in and no leave, is marked
// **ATTENDED** and its course/voucher quota is deducted. Idempotent: only CONFIRMED rows are touched, so a
// second run marks nothing.
//
// 🔴 REQ-070 / TASK-180: this used to write **NO_SHOW**, and that was a false claim about a child. `NO_SHOW`
// had exactly one writer — this line — no human could set it, and quota already treated `{ATTENDED, NO_SHOW}`
// identically (`course-plan.ts`), so the label carried no mechanism at all: it only told a family their child
// had not turned up because nobody pressed a button. On `uat` it did that to 15 real children in one weekend.
// Good customers are separated by **CRM points at check-in**, and this path awards none — that absence is the
// signal, and it is deliberately kept. `NO_SHOW` stays in the enum so historical rows still render.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, coursePackages, jobRuns, vouchers } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";
import { recordSale } from "../lib/sale-post";
import { listPriceMinor, revenueItemRef } from "../lib/sale-items";
import { safeStoredDiscount } from "../lib/discount-plan";
import { getDailyReport, resolvePriceGroup } from "./scheduler.service";

export async function runEndOfDayJob(date?: string) {
  const now = bangkokNow();
  const runDate = date ?? now.date;

  const marked = await db.transaction(async (tx) => {
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

    let coursesAutoAttended = 0;
    let vouchersAutoAttended = 0;
    for (const b of due) {
      await tx.update(bookings).set({ status: "ATTENDED" }).where(eq(bookings.id, b.id));
      if (b.courseId) {
        await tx
          .update(coursePackages)
          .set({ usedSessions: sql`${coursePackages.usedSessions} + 1` })
          .where(eq(coursePackages.id, b.courseId));
        coursesAutoAttended++;
      }
      if (b.voucherId) {
        await tx
          .update(vouchers)
          .set({ usedHours: sql`${vouchers.usedHours} + 1` })
          .where(eq(vouchers.id, b.voucherId));
        vouchersAutoAttended++;
      }
    }

    // Named for what they now are: sessions the job marked attended because nobody marked them. A `job_runs`
    // reader must not be able to read "noShow" out of a system that can no longer produce one.
    return { autoAttended: due.length, coursesAutoAttended, vouchersAutoAttended };
  });

  // 🔴 REQ-070 / TASK-180 — a consequence worth naming, because it is money. This select is
  // `status = ATTENDED`, and the block above now writes ATTENDED where it used to write NO_SHOW. So a 1st
  // Trial or single session that **nobody marked** will, from this change on, post its revenue here — where
  // before it became NO_SHOW and posted nothing.
  //
  // That is arguably right (the slot was held and the session ended) and arguably wrong (nobody confirmed the
  // child came, and the money may never have been collected). It is NOT a decision this task was asked to
  // make, so it is left as the plain consequence of the owner's design rather than quietly special-cased —
  // see the task's Q1. Special-casing it would need a "was auto-marked" marker to stay correct across re-runs,
  // which is a column, not a condition.
  // TASK-007: recognise revenue for attended one-off bookings (FIRST_TRIAL / SINGLE_SESSION) at
  // day-end. Course/voucher already booked revenue at sale (recordSale on creation) → not re-posted
  // here. Best-effort + idempotent (`rev:<bookingId>`): safe to re-run; skips if ops is off or the
  // INCOME item isn't seeded; never fails the job.
  const attended = await db
    .select({
      id: bookings.id,
      bookingType: bookings.bookingType,
      subjectId: bookings.subjectId,
      // TASK-162: the discount an admin authorised when this session was BOOKED. Posting is deferred to here;
      // the decision and its author are not.
      discountKind: bookings.discountKind,
      discountValue: bookings.discountValue,
      discountReason: bookings.discountReason,
      discountActor: bookings.discountActor,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.date, runDate),
        eq(bookings.status, "ATTENDED"),
        inArray(bookings.bookingType, ["FIRST_TRIAL", "SINGLE_SESSION"]),
      ),
    );

  let revenuePosted = 0;
  for (const b of attended) {
    // TASK-077: a SINGLE_SESSION is priced by PROGRAM (1,690 / 1,390 / 1,090 an hour), so the item depends
    // on the booking's subject. FIRST_TRIAL is one price for everyone and ignores the group.
    const priceGroup = await resolvePriceGroup(b.subjectId);
    const ref = revenueItemRef(b.bookingType, priceGroup);
    if (!ref) {
      // Loud, not silent — TASK-066's lesson. A single session on a program with no price group (or on
      // bike/skate, which has no 1-hour rate on the card) must not fall back to some default price.
      if (b.bookingType === "SINGLE_SESSION") {
        console.error(
          `[sale] NOT POSTED — no price group for booking ${b.id}'s program, so its single-session rate ` +
            `is unknown. Revenue for this session is NOT in the books.`,
        );
      }
      continue;
    }
    // Amount defaults to quantity × the INCOME item's sale_price_minor (don't hardcode prices).
    // TASK-162 (REQ-063): re-validate the stored discount against the list price at POSTING time — the price
    // could have changed between booking and day-end, and a stale amount must refuse rather than post a
    // discount larger than the sale. Same `planDiscount` as the at-sale path; no second rule.
    const discount = b.discountKind
      ? safeStoredDiscount(
          { kind: b.discountKind as "PERCENT" | "BAHT", value: b.discountValue ?? 0, reason: b.discountReason ?? "" },
          listPriceMinor(ref) ?? 0,
          b.discountActor,
          b.id,
        )
      : undefined;
    const res = await recordSale(ref, 1, { refId: b.id, idempotencyKey: `rev:${b.id}`, discount });
    if (res.ok) revenuePosted++;
  }

  // Report is read after the auto-mark so its counts reflect the newly-ATTENDED rows.
  const report = await getDailyReport(runDate);
  const summary = { ...marked, revenuePosted, report };

  await db.insert(jobRuns).values({
    job: "end-of-day",
    runDate,
    status: "success",
    summary,
    finishedAt: new Date(),
  });

  return { date: runDate, ranAt: now.time, ...summary };
}
