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
import { enqueueLine } from "../lib/line";
import { groupReminders, reminderReach } from "../lib/daily-reminder";

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

// ─────── SPEC-066 / TASK-208 (REQ-072 3B) — the 08:15 "you have a class today" push ───────

export const REMINDER_JOB = "daily-reminder";

/** Has the reminder already gone out for this business date? Read before sending, like the digest. */
async function reminderAlreadySent(runDate: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(jobRuns)
    .where(and(eq(jobRuns.job, REMINDER_JOB), eq(jobRuns.runDate, runDate)));
  // 🔴 TASK-209: keyed on `attempted`, NOT on `sent`. `sent` is now a delivered COUNT, and a day where every
  // recipient was unlinked delivers 0 — reading "already sent" off that number would make the job re-run all
  // morning on exactly the days it reached nobody.
  return rows.some((r) => (r.summary as any)?.attempted === true);
}

/**
 * The 08:15 daily reminder. **One message per person** — every teacher who teaches today, every parent whose
 * child has a class today — and a `job_runs` row either way.
 *
 * 🔴 The `job_runs` row is not bookkeeping. Two scheduled jobs on this project were **never registered on the
 * server and nobody noticed for weeks**; the day-end job turned out not to have run on `uat` at all. That row
 * is the only thing that makes *"did it fire this morning?"* answerable without guessing, and it is written
 * even when there is nothing to send.
 *
 * Idempotent per business date: a second run — a retry, or both boxes firing — sends nothing.
 */
export async function runDailyReminderJob(date?: string) {
  const runDate = date ?? bangkokNow().date;

  // 🔴 TASK-209 — the guard gates the SEND, never the RECORD.
  //
  // This used to `return` here, so a second run sent nothing **and wrote nothing** — leaving "ran, nothing to
  // do" and "never ran" indistinguishable, which is the one property these job rows exist to preserve. The row
  // is now written on **every** invocation; a re-run records `attempted: false, sent: 0`.
  if (await reminderAlreadySent(runDate)) {
    await db.insert(jobRuns).values({
      job: REMINDER_JOB,
      runDate,
      status: "success",
      summary: { attempted: false, sent: 0, reason: "already-sent" },
      finishedAt: new Date(),
    });
    return { date: runDate, skipped: "already-sent" as const, sent: 0 };
  }

  const rows = await db.query.bookings.findMany({
    where: (b: any, { eq: e }: any) => e(b.date, runDate),
    with: { teacher: true, student: true, subject: true },
  });

  // Parents in one query, not one per student — a Saturday is ~60 sessions.
  const parentIds = [...new Set(rows.map((r: any) => r.student?.parentId).filter(Boolean))] as string[];
  const parents = parentIds.length
    ? await db.query.parents.findMany({ where: (p: any, { inArray: inA }: any) => inA(p.id, parentIds) })
    : [];
  const parentById = new Map(parents.map((p: any) => [p.id, p]));

  const groups = groupReminders(
    rows.map((r: any) => ({
      id: r.id,
      date: r.date,
      startTime: r.startTime,
      status: r.status,
      teacherId: r.teacherId ?? null,
      teacherLineUserId: r.teacher?.lineUserId ?? null,
      studentId: r.studentId ?? null,
      studentName: r.student?.nickname ?? r.student?.name ?? "-",
      parentId: r.student?.parentId ?? null,
      parentLineUserId: r.student?.parentId
        ? (parentById.get(r.student.parentId)?.lineUserId ?? null)
        : null,
      subjectName: r.subject?.name ?? "-",
    })),
  );

  // 🔴 Counted BEFORE sending, and returned. On `uat` most parents were imported and have never linked LINE —
  // a reminder feature that reaches nobody looks identical to one that works, for as long as nobody checks.
  const reach = reminderReach(groups);

  // 🔴 TASK-209 — `sent` is the number ACTUALLY queued for delivery, not a boolean.
  //
  // The first version recorded `sent: true` on a run that reached **zero** people (every recipient unlinked on
  // `sid`). Anyone reading `job_runs` to answer *"who did we notify this morning?"* got the wrong answer — the
  // same class as counting a replayed sale as revenue. `attempted` is the separate fact that the job ran, so
  // "it fired and reached nobody" and "it never fired" stay distinguishable in both directions.
  let sent = 0;
  let skipped = 0;
  for (const g of groups) {
    const result = await enqueueLine({
      recipientType: g.recipientType,
      recipientLineUserId: g.lineUserId,
      // The rows travel in the payload so the worker renders them with the owner-verified `ตารางวันนี้`
      // composer in each recipient's own language — no second format, no per-booking enrichment.
      payload: { kind: "daily_reminder", rows: g.rows },
      skipReason: g.lineUserId ? undefined : "ยังไม่ผูก LINE",
    });
    if (result.status === "skipped") skipped++;
    else sent++;
  }

  await db.insert(jobRuns).values({
    job: REMINDER_JOB,
    runDate,
    status: "success",
    summary: { attempted: true, sent, skipped, ...reach },
    finishedAt: new Date(),
  });

  return { date: runDate, attempted: true, sent, skipped, ...reach };
}
