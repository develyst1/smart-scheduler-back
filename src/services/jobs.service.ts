// End-of-day auto-mark job (UC-012). Triggered by a Windows Task Scheduler exe
// (see scripts/end-of-day.ts) that POSTs the internal endpoint. All logic lives
// here — the exe is a thin trigger — so it can also be run by hand or re-run.
//
// A CONFIRMED class on the target date whose START time has passed, with no check-in and no leave, is marked
// **ATTENDED** and its course/voucher quota is deducted. Idempotent: only CONFIRMED rows are touched, so a
// second run marks nothing.
//
// 🔴 TASK-396 (the OWNER'S RULING, 2026-09-18, via @Porter) — the gate is the START time, not the end. The team
// leaves at 17:30 and wants every class cut before they go, and the trigger cannot move to 18:30 — so the 17:30
// run attends a 17:00–18:00 class because it has STARTED. This is a CONSCIOUS OVERRIDE of REQ-070's "a session is
// never attended before it ends": staff are on-site and review the day before leaving, which is what makes
// attending a class in progress acceptable to the owner. It used to gate on `end_time <= now`, and a 17:00 class
// at the 17:30 run was (correctly, by the old rule) skipped and cut the next morning — the owner called that a bug.
// The past-date branch, the future-date branch, what is written and the trigger time are all unchanged.
//
// 🔴 REQ-070 / TASK-180: this used to write **NO_SHOW**, and that was a false claim about a child. `NO_SHOW`
// had exactly one writer — this line — no human could set it, and quota already treated `{ATTENDED, NO_SHOW}`
// identically (`course-plan.ts`), so the label carried no mechanism at all: it only told a family their child
// had not turned up because nobody pressed a button. On `uat` it did that to 15 real children in one weekend.
// Good customers are separated by **CRM points at check-in**, and this path awards none — that absence is the
// signal, and it is deliberately kept. `NO_SHOW` stays in the enum so historical rows still render.
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, coursePackages, jobRuns, lineWebhookEvents, notificationOutbox, vouchers } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";
import { discountKey, postBookingSale, recordSale, revGeneration, revKey } from "../lib/sale-post";
import { OTHER_BOOKING_REF, SALE_SOURCE, listPriceMinor, revenueItemRef } from "../lib/sale-items";
import { safeStoredDiscount } from "../lib/discount-plan";
import { getDailyReport, groupKindOf, resolvePriceGroup } from "./scheduler.service";
import { cutCampDays, notifyCampDeductions } from "./camp.service";
import { notifyCourseDeduction, remainingLabel } from "../lib/course-deduction";
import { joinCoaches } from "../lib/coach-names";
import { familyLineUserIdsBulk } from "../lib/family-link";
import { displayNameOf } from "../db/mappers";
import { enqueueLine } from "../lib/line";
import { REMINDER_JOB, reminderRanOn } from "../lib/reminder-run";
import { rentalPrintLine } from "../lib/rental-row";
import { REMINDABLE, dueSends, groupReminders, reminderReach, reminderSends } from "../lib/daily-reminder";
import { campReminderSends } from "../lib/camp-reminder";
import { WEEKLY_DIGEST_JOB, groupWeekRows, weekOf, weeklyDigestKey } from "../lib/weekly-digest";
import { GROUP_EXTENDER_JOB, weeklyDatesToCreate } from "../lib/group-extend";
import { COURSE_LIVE, COURSE_LIVE_STATUSES } from "../lib/course-plan";
import { attachAdditionalTeachers, insertBooking } from "./scheduler.service";
import { ApiException } from "../lib/http";
import { addDays, hhmm } from "../lib/time";
import { campReminderInputs } from "./camp.service";
import { getNumberSetting, getSetting } from "./settings.service";

/** TASK-460 — how long a delivered event id is remembered. A week covers every re-delivery window LINE uses. */
export const WEBHOOK_EVENT_TTL_DAYS = 7;

export async function runEndOfDayJob(date?: string) {
  const now = bangkokNow();
  const runDate = date ?? now.date;

  const marked = await db.transaction(async (tx) => {
    // Which CONFIRMED classes on runDate have already STARTED? (TASK-396 — the owner's ruling; it was "ended".)
    //  - past date  → all of them
    //  - today      → only those whose START time is at/behind the Bangkok clock
    //  - future     → none
    const ended =
      runDate < now.date
        ? sql`true`
        : runDate === now.date
          ? sql`${bookings.startTime} <= ${now.time}::time`
          : sql`false`;

    const due = await tx
      .select({
        id: bookings.id,
        courseId: bookings.courseId,
        voucherId: bookings.voucherId,
        // TASK-254 — who the deduction message is for. Taken from the row the job already has in hand; a second
        // read later would be a second chance to disagree with it.
        studentId: bookings.studentId,
        coStudentId: bookings.coStudentId, // TASK-420 — the deduction reaches both households
      })
      .from(bookings)
      .where(and(eq(bookings.date, runDate), eq(bookings.status, "CONFIRMED"), ended));

    let coursesAutoAttended = 0;
    let vouchersAutoAttended = 0;
    for (const b of due) {
      await tx.update(bookings).set({ status: "ATTENDED", checkinSource: "end-of-day" }).where(eq(bookings.id, b.id)); // TASK-475 — provenance
      if (b.courseId) {
        // 🔴 TASK-254 — deduction site 2 of 2, and since REQ-070 it is the MAJORITY path: the day-end
        // auto-attends every unmarked class, so most sessions are deducted here rather than by a person.
        //
        // `.returning()` because this write is `used + 1` **in SQL** — the post-value exists only in the
        // database until it is read back. 🚫 Never a second SELECT: a concurrent write between them would print
        // a number that was true at neither moment. `Remaining` comes from the write that caused the message.
        const [course] = await tx
          .update(coursePackages)
          .set({ usedSessions: sql`${coursePackages.usedSessions} + 1` })
          .where(eq(coursePackages.id, b.courseId))
          .returning();
        coursesAutoAttended++;
        if (course) {
          await notifyCourseDeduction(tx, {
            bookingId: b.id,
            studentId: b.studentId,
            coStudentId: b.coStudentId ?? null, // TASK-420
            kind: "course",
            used: course.usedSessions,
            total: course.size,
            expiryDate: course.expiryDate ?? null,
          });
        }
      }
      if (b.voucherId) {
        const [voucher] = await tx
          .update(vouchers)
          .set({ usedHours: sql`${vouchers.usedHours} + 1` })
          .where(eq(vouchers.id, b.voucherId))
          .returning();
        vouchersAutoAttended++;
        if (voucher) {
          await notifyCourseDeduction(tx, {
            bookingId: b.id,
            studentId: b.studentId,
            coStudentId: b.coStudentId ?? null, // TASK-420
            kind: "voucher",
            used: voucher.usedHours,
            total: voucher.totalHours,
            expiryDate: voucher.expiryDate ?? null,
          });
        }
      }
    }

    // TASK-401 (REQ-095 Stage 3a) — the CAMP DAY CUT, in the SAME transaction: every PLANNED camp day whose date has
    // started (`date <= runDate`) ⇒ ATTENDED, its units consumed. A day has no start time, so "started" is the date.
    const campDaysAutoAttended = await cutCampDays(tx, runDate);
    const campDeductionsNotified = await notifyCampDeductions(tx, runDate); // TASK-443 — after the cut, so the credit it prints is post-consumption

    // Named for what they now are: sessions the job marked attended because nobody marked them. A `job_runs`
    // reader must not be able to read "noShow" out of a system that can no longer produce one.
    return { autoAttended: due.length, coursesAutoAttended, vouchersAutoAttended, campDaysAutoAttended, campDeductionsNotified };
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
  // SPEC-070 / TASK-225 (REQ-078 AC-5/AC-6): `OTHER` joins the sweep. It posts on the SAME
  // `rev:<bookingId>` key as the trial/single path — deliberately, so SPEC-069's "this booking's revenue is
  // already posted" warning covers อื่นๆ the day this lands, with no second lookup and no type list to keep in
  // step. Its amount does not come from a product code, so it takes the `postBookingSale` branch below.
  const attended = await db
    .select({
      id: bookings.id,
      bookingType: bookings.bookingType,
      subjectId: bookings.subjectId,
      // TASK-399 — a walk-in SEAT posts by its GROUP's kind, not its subject (else a DUO seat would post the Private price).
      groupId: bookings.groupId,
      // TASK-225 — the อื่นๆ charge, as chosen at booking time. Exactly one of the two is ever set
      // (`booking_other_price_chk`); both null means the booking was not charged.
      otherPriceMinor: bookings.otherPriceMinor,
      otherPriceItemId: bookings.otherPriceItemId,
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
        inArray(bookings.bookingType, ["FIRST_TRIAL", "SINGLE_SESSION", "OTHER"]),
      ),
    );

  let revenuePosted = 0;
  for (const b of attended) {
    // ── TASK-225: an อื่นๆ booking is priced by the BOOKING, not by a product code ──
    if (b.bookingType === "OTHER") {
      const res = await postOtherBookingSale(b);
      if (res) revenuePosted++;
      continue;
    }
    // TASK-077: a SINGLE_SESSION is priced by PROGRAM (1,690 / 1,390 / 1,090 an hour), so the item depends
    // on the booking's subject. FIRST_TRIAL is one price for everyone and ignores the group.
    // TASK-399 — the FIFTH caller of the resolver, and the one that POSTS: a seat's price is its group's kind.
    const priceGroup = await resolvePriceGroup(b.subjectId, b.groupId ? await groupKindOf(db, b.groupId) : null);
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
    // 🔴 TASK-258 — the key carries the GENERATION, so a booking whose attendance was undone and re-marked
    // posts again instead of returning `{ ok: true, skipped: "duplicate" }` and writing nothing (AC-8).
    // Generation 0 is the un-suffixed `rev:<id>` every historical row already carries, so nothing re-posts.
    const generation = await revGeneration(b.id);
    const res = await recordSale(ref, 1, {
      refId: b.id,
      idempotencyKey: revKey(b.id, generation),
      discountKey: discountKey(b.id, generation),
      discount,
    });
    if (res.ok) revenuePosted++;
  }

  // 🔴 TASK-460 — sweep the webhook idempotency store (> WEBHOOK_EVENT_TTL_DAYS). It rides THIS job on purpose:
  // a job of its own would be an exe plus a Task Scheduler registration only the human can perform, for a table of
  // one-line rows (TASK-456's shape). The count is in the summary, so a sweep that silently stops is visible.
  const swept = await db
    .delete(lineWebhookEvents)
    .where(lt(lineWebhookEvents.seenAt, new Date(Date.now() - WEBHOOK_EVENT_TTL_DAYS * 86_400_000)))
    .returning({ id: lineWebhookEvents.webhookEventId });

  // Report is read after the auto-mark so its counts reflect the newly-ATTENDED rows.
  const report = await getDailyReport(runDate);
  const summary = { ...marked, revenuePosted, webhookEventsSwept: swept.length, report };

  await db.insert(jobRuns).values({
    job: "end-of-day",
    runDate,
    status: "success",
    summary,
    finishedAt: new Date(),
  });

  return { date: runDate, ranAt: now.time, ...summary };
}

/**
 * SPEC-070 / TASK-225 (REQ-078 AC-4/AC-5/AC-6) — post one attended อื่นๆ booking's charge, if it has one.
 *
 * Returns `true` only when a movement is now in the books (including an idempotent replay of one that already
 * was), so the caller's `revenuePosted` counter keeps meaning what it has always meant.
 *
 * 🔴 **AC-4 — an UNCHARGED booking writes nothing at all. Not a ฿0 movement.** "Free" and "sold for nothing"
 * are different claims: a zero row reads in the ledger as a sale that happened, and a report that lists it has
 * to explain it. The absence is the honest record, and the DoD asserts the absence rather than a zero.
 */
async function postOtherBookingSale(b: {
  id: string;
  otherPriceMinor: number | null;
  otherPriceItemId: string | null;
}): Promise<boolean> {
  // Not charged ⇒ nothing to post. Checked before anything is read, so an uncharged อื่นๆ booking costs the
  // day-end job one comparison and touches no money at all.
  if (b.otherPriceMinor == null && b.otherPriceItemId == null) return false;

  // 🔴 TASK-258 — the same generation rule as the trial/single path above. อื่นๆ posts on the SAME key family
  // deliberately (TASK-225), so it must follow the same sequence or an undone-and-re-marked อื่นๆ would be the
  // one type that silently stops re-posting.
  const idempotencyKey = revKey(b.id, await revGeneration(b.id));

  // 🔴 The whole body is wrapped, because this file's first rule is that revenue posting must NEVER fail the
  // job it runs inside. `postBookingSale` already honours that for its own writes, but the item LOOKUPS here
  // are mine — an unreachable `bo` schema would otherwise throw out of `runEndOfDayJob` and the day's
  // auto-attend, quota deduction and `job_runs` row would all be lost to a bookkeeping read.
  try {
    // AC-6 — a CATALOGUE charge posts on that item's own id, so a report can break อื่นๆ revenue down by what
    // it was for. The amount is the item's price **read now**, not one captured at booking time: the same rule
    // the stored discount already follows, and for the same reason — the posted number must be the one that is
    // true when it posts.
    if (b.otherPriceItemId) {
      const item = await db.query.boItem.findFirst({
        where: (i, { eq: e }) => e(i.id, b.otherPriceItemId!),
      });
      if (!item || !item.active) {
        console.error(
          `[sale] NOT POSTED — booking ${b.id} was charged to catalogue item ${b.otherPriceItemId}, which is ` +
            `${item ? "INACTIVE" : "missing"} at posting time. Revenue for this booking is NOT in the books; ` +
            `no fallback price was invented.`,
        );
        return false;
      }
      const res = await postBookingSale({
        itemId: item.id,
        amountMinor: item.unitPriceMinor,
        refId: b.id,
        idempotencyKey,
      });
      return res.ok;
    }

    // AC-5 — a TYPED amount posts to the `other-booking` bucket. The item's own `unit_price_minor` is a
    // placeholder and is deliberately not read (see `OTHER_BOOKING_REF`); the amount is the one that was typed.
    const bucket = await db.query.boItem.findFirst({
      where: (i, { and: a, eq: e }) =>
        a(e(i.externalSource, SALE_SOURCE), e(i.externalRef, OTHER_BOOKING_REF)),
    });
    if (!bucket) {
      // TASK-066's exact failure, and the reason `sale:ensure-items` is in this task's deploy note: an item
      // that was never seeded on this box makes every อื่นๆ charge vanish, silently, until somebody checks.
      console.error(
        `[sale] NOT POSTED — no bo.item for external_ref='${OTHER_BOOKING_REF}' (booking ${b.id}). ` +
          `Run \`bun run sale:ensure-items\` on this box — revenue for this booking is NOT in the books.`,
      );
      return false;
    }
    return (
      await postBookingSale({
        itemId: bucket.id,
        amountMinor: b.otherPriceMinor!,
        refId: b.id,
        idempotencyKey,
      })
    ).ok;
  } catch (e) {
    // Rule 2: never silently. The booking keeps its ATTENDED status and its quota effects; only the money
    // failed, and it says so with the id so it can be posted by hand.
    console.error(
      `[sale] NOT POSTED — could not read the catalogue for booking ${b.id}. Revenue for this booking is ` +
        `NOT in the books:`,
      e,
    );
    return false;
  }
}

// ─────── SPEC-066 / TASK-208 (REQ-072 3B) — the 08:15 "you have a class today" push ───────

export { REMINDER_JOB } from "../lib/reminder-run"; // TASK-375: one home for the name and the read

/**
 * Had this business date already fired at least once before this invocation? **Observability only.**
 *
 * 🔴 TASK-218 — this function used to be the suppression gate (`reminderAlreadySent`), and that was the bug:
 * a manual trigger at 07:00 wrote `attempted: true`, so the real 08:15 scheduled run skipped and **the day's
 * reminders were silently eaten**. Suppression now lives per-recipient (`reminderKey`), where re-running is
 * harmless. This survives only because *"was 08:15 the first firing today, or did something beat it?"* is the
 * question an operator asks when a morning looks wrong — and it is now recorded, never acted on.
 *
 * ⚠️ **Never re-wire this into an `if` around the send.** Both job-level flags are wrong: `sent` re-runs all
 * morning on a day that reached nobody, `attempted` eats the day.
 */
// TASK-375: the read lives in `lib/reminder-run.ts` now (`reminderRanOn`) — a second reader, the same-day rental
// notice, needed it without closing an import cycle through `scheduler.service` → `rental.service`. Same read,
// byte for byte, TASK-209's `attempted` key included; this file keeps its name for the one caller below.
const reminderRanToday = (runDate: string): Promise<boolean> => reminderRanOn(runDate);

/**
 * The 08:15 daily reminder. **One message per person** — every teacher who teaches today, every parent whose
 * child has a class today — and a `job_runs` row either way.
 *
 * 🔴 The `job_runs` row is not bookkeeping. Two scheduled jobs on this project were **never registered on the
 * server and nobody noticed for weeks**; the day-end job turned out not to have run on `uat` at all. That row
 * is the only thing that makes *"did it fire this morning?"* answerable without guessing, and it is written
 * even when there is nothing to send.
 *
 * 🔴 TASK-218 — idempotent **per recipient per business date**, not per job. The job may run any number of
 * times a day: each run sends only to people not already reminded today, so a 07:00 ops trigger reminds whoever
 * is due, the 08:15 run reminds the rest, and nobody is sent to twice.
 */
export async function runDailyReminderJob(date?: string) {
  const runDate = date ?? bangkokNow().date;

  // Recorded, not acted on — see `reminderRanToday`. Read BEFORE this run writes its own row, or it would
  // always report itself.
  const priorRunToday = await reminderRanToday(runDate);

  const rows = await db.query.bookings.findMany({
    where: (b: any, { eq: e }: any) => e(b.date, runDate),
    // TASK-228 (AC-16): the ADDITIONAL teachers travel with the booking, so an อื่นๆ session appears on every
    // assigned teacher's schedule. Loaded in the query rather than looked up per booking — a Saturday is ~60
    // sessions, and a per-row lookup here is the shape this job was written to avoid.
    with: {
      teacher: true,
      student: true,
      coStudent: true, // TASK-420 — a DUO row's second child (its household gets the row too)
      subject: true,
      additionalTeachers: { with: { teacher: true } },
      // SPEC-072 / TASK-256 — REQ-077 Parent 2 prints `Remaining` and `*Expiry date`. Two more relations on the
      // SAME query, not a per-row lookup: a Saturday is ~60 sessions, and that is the shape this job avoids.
      course: true,
      voucher: true,
      rental: true, // TASK-375 — the row relation (TASK-371); no extra read
      seats: { with: { student: true, course: true } }, // TASK-397 — a GROUP row's seats, for the coach's folded entry
    },
  });

  // Parents in one query, not one per student — a Saturday is ~60 sessions.
  const parentIds = [...new Set(rows.flatMap((r: any) => [r.student?.parentId, r.coStudent?.parentId]).filter(Boolean))] as string[]; // TASK-420 — both households
  const parents = parentIds.length
    ? await db.query.parents.findMany({ where: (p: any, { inArray: inA }: any) => inA(p.id, parentIds) })
    : [];
  const parentById = new Map(parents.map((p: any) => [p.id, p]));
  // 🔴 TASK-259 — every account each family has linked, in TWO queries for the whole day. The single accessor
  // in a loop would put back the per-row lookup this job exists to avoid, so the bulk shape is used — and it is
  // the same function underneath, so its answer cannot differ from the one every other sender gets.
  const familyAccounts = await familyLineUserIdsBulk(parentIds);

  const groups = groupReminders(
    rows.map((r: any) => ({
      id: r.id,
      date: r.date,
      startTime: r.startTime,
      status: r.status,
      teacherId: r.teacherId ?? null,
      teacherLineUserId: r.teacher?.lineUserId ?? null,
      // TASK-228 (AC-16) — every other assigned teacher gets this session on their own schedule too.
      additionalTeachers: (r.additionalTeachers ?? [])
        .filter((a: any) => a?.teacher)
        .map((a: any) => ({ id: a.teacher.id, lineUserId: a.teacher.lineUserId ?? null })),
      studentId: r.studentId ?? null,
      // 🔴 TASK-228 — the SAME `displayName` rule the DTO computes (`db/mappers.ts`): an อื่นๆ session reads as
      // the title the admin typed, every other type as the student's nickname exactly as before. The trailing
      // `"-"` stays as the last-resort for a lesson booking whose student row went missing — it is not, and
      // must never become, the fallback for อื่นๆ, which validation guarantees has a title when it has no
      // student. Never the words "อื่นๆ" / "Other" (REQ-078 📌).
      studentName: displayNameOf(r) || "-", // TASK-423 — the ONE name rule (an อื่นๆ title; a DUO row's `A & B`; the nickname)
      parentId: r.student?.parentId ?? null,
      coParentId: r.coStudent?.parentId ?? null, // TASK-420 — the second household (the same parent ⇒ one entry, by the grouper)
      coParentLineUserIds: r.coStudent?.parentId ? (familyAccounts.get(r.coStudent.parentId) ?? []) : [],
      parentLineUserId: r.student?.parentId
        ? (parentById.get(r.student.parentId)?.lineUserId ?? null)
        : null,
      // 🔴 TASK-259 — the whole family, resolved once above rather than per row.
      parentLineUserIds: r.student?.parentId ? (familyAccounts.get(r.student.parentId) ?? []) : [],
      // `null`, not `"-"`: an อื่นๆ booking has no program, and `renderSchedule` omits the segment rather than
      // printing a placeholder that reads as a program nobody recorded.
      subjectName: r.subject?.name ?? null,
      // SPEC-072 / TASK-256 — the rest of REQ-077 Parent 2, straight off the rows this job already loaded.
      // 🔴 TASK-283 — RAW, both ends. `groupReminders` builds the payload row and formats it there,
      // so one file owns the whole range. This used to trim `endTime` while `startTime` went through raw.
      endTime: r.endTime ?? null,
      bookingType: r.bookingType ?? null,
      title: r.otherTitle ?? null,
      size: r.course?.size ?? r.voucher?.totalHours ?? null,
      // 🔴 The balance as it stands NOW — before today's class is deducted at check-in or at the day-end. It is
      // rendered by the ONE helper TASK-254 wrote, so the same number reads the same way in both messages.
      remaining: r.course
        ? remainingLabel("course", r.course.size - r.course.usedSessions, r.course.size)
        : r.voucher
          ? remainingLabel("voucher", r.voucher.totalHours - r.voucher.usedHours, r.voucher.totalHours)
          : null,
      expiryDate: r.course?.expiryDate ?? r.voucher?.expiryDate ?? null,
      // The same joiner the outbox worker uses — one definition of `Coach` (TASK-256 pulled it into a lib).
      coach: joinCoaches(r.teacher, r.additionalTeachers ?? []) ?? null,
      // 🔴 REQ-085 §7.2 (TASK-304) — the booking's OWN note reaches its own entry.
      attendeeNote: r.attendeeNote ?? null,
      // TASK-375 — rendered HERE, once, like `remaining`: the builder decides who and which rows, never the words.
      rental: r.rental ? rentalPrintLine(r.rental.code, r.rental.remark ?? null) : null,
      // TASK-394 — an OTHER's head count reaches the coach's entry; `null` on every lesson row by construction.
      headCount: r.headCount ?? null,
      // TASK-397 — a GROUP row's seats, for the coach's folded entry; a seat's group id, so it is not its own entry there.
      groupId: r.groupId ?? null,
      campWeekDayId: r.campWeekDayId ?? null, // TASK-418 — the fold key
      otherKind: r.otherKind ?? null,
      slotYieldedAt: r.slotYieldedAt ?? null, // TASK-453b — the clash half the row itself carries
      seats: r.bookingType === "GROUP" ? (r.seats ?? []).filter((x: any) => REMINDABLE.has(x.status)).map((x: any) => ({ studentName: x.student?.nickname ?? x.student?.name ?? "", remaining: x.course ? remainingLabel("course", x.course.size - x.course.usedSessions, x.course.size) : null })) : null,
    })),
  );

  // 🔴 Counted BEFORE sending, and returned. On `uat` most parents were imported and have never linked LINE —
  // a reminder feature that reaches nobody looks identical to one that works, for as long as nobody checks.
  const reach = reminderReach(groups);

  // 🔴 TASK-218 — who has ALREADY been reminded today, read in ONE query keyed on the outbox.
  //
  // This is the fast path only. The `notification_outbox_idempotency_uq` index is what actually makes a
  // double-send impossible when two boxes fire at the same moment — read-then-write alone is a race, and
  // `enqueueLine` reports that collision back as `duplicate` rather than throwing.
  // 🔴 TASK-259 — one send per DEVICE, so the keys are read per device too. A family's two rows carry two keys;
  // sharing one would let the unique index swallow the second parent silently — the defect this task closes.
  const sends = reminderSends(groups, runDate);
  const keys = sends.map((s) => s.key);
  const alreadyKeyed = new Set(
    keys.length
      ? (
          await db
            .select({ key: notificationOutbox.idempotencyKey })
            .from(notificationOutbox)
            .where(inArray(notificationOutbox.idempotencyKey, keys))
        ).map((r) => r.key as string)
      : [],
  );
  const due = dueSends(sends, alreadyKeyed);

  // 🔴 TASK-209 — `sent` is the number ACTUALLY queued for delivery, not a boolean.
  //
  // The first version recorded `sent: true` on a run that reached **zero** people (every recipient unlinked on
  // `sid`). Anyone reading `job_runs` to answer *"who did we notify this morning?"* got the wrong answer — the
  // same class as counting a replayed sale as revenue. `attempted` is the separate fact that the job ran, so
  // "it fired and reached nobody" and "it never fired" stay distinguishable in both directions.
  let sent = 0;
  let skipped = 0;
  // TASK-218: people this run deliberately did not send to because they already had today's reminder. It is a
  // separate count from `skipped` (= unreachable, no LINE link) on purpose — "already done" and "cannot reach"
  // are the two answers an operator is choosing between when a morning looks short.
  let alreadyReminded = sends.length - due.length;
  for (const g of due) {
    const result = await enqueueLine({
      recipientType: g.recipientType,
      recipientLineUserId: g.lineUserId,
      // The rows travel in the payload so the worker renders them with the owner-verified `ตารางวันนี้`
      // composer in each recipient's own language — no second format, no per-booking enrichment.
      payload: { kind: "daily_reminder", rows: g.rows },
      skipReason: g.lineUserId ? undefined : "ยังไม่ผูก LINE",
      // 🔴 The send-once key. A SKIPPED row never stores it (`lib/line.ts`), so someone who was unlinked at
      // 07:00 and links LINE by 08:15 is still reached — an unreachable person was not reminded.
      idempotencyKey: g.key,
    });
    if (result.status === "duplicate") alreadyReminded++;
    else if (result.status === "skipped") skipped++;
    else sent++;
  }

  // 🔴 TASK-403 (REQ-095 Stage 3b) — the CAMP-day reminder, AFTER the session sends and behind a settings flag.
  // `camp_reminder_enabled` is `off` by default (the words are PLACEHOLDER until the owner approves Porter's copy):
  // OFF ⇒ nothing is read, built or enqueued — `campReminded: 0`, `campEnabled: false` in the run summary. ON ⇒ a
  // SEPARATE select on `camp_days` (the session select above is REQ-094's byte-frozen one and stays untouched), the
  // pure builder, and `enqueueLine` per send under its own `camp-reminder:` key (a family with a session AND a camp
  // day today gets both messages; a second run the same morning enqueues nothing).
  const campEnabled = (await getSetting("camp_reminder_enabled")).value === "on";
  let campReminded = 0, campSkipped = 0, campAlready = 0;
  if (campEnabled) {
    const { days, weeks } = await campReminderInputs(runDate);
    const campSends = campReminderSends(days, weeks, runDate);
    for (const g of campSends) {
      const result = await enqueueLine({
        recipientType: g.recipientType,
        recipientLineUserId: g.lineUserId,
        payload: g.payload,
        skipReason: g.lineUserId ? undefined : "ยังไม่ผูก LINE",
        idempotencyKey: g.key,
      });
      if (result.status === "duplicate") campAlready++;
      else if (result.status === "skipped") campSkipped++;
      else campReminded++;
    }
  }

  await db.insert(jobRuns).values({
    job: REMINDER_JOB,
    runDate,
    status: "success",
    summary: { attempted: true, sent, skipped, alreadyReminded, priorRunToday, ...reach, campEnabled, campReminded, campSkipped, campAlready },
    finishedAt: new Date(),
  });

  return { date: runDate, attempted: true, sent, skipped, alreadyReminded, priorRunToday, ...reach, campEnabled, campReminded, campSkipped, campAlready };
}

// ─────── TASK-441 (REQ-104 §2 item 2) — the Monday weekly coach digest ───────
//
// The SAME shape as the daily reminder: a Windows Task Scheduler exe (`scripts/weekly-teacher-digest.ts`) hits
// `POST /internal/jobs/weekly-teacher-digest` on Monday 08:15 (the human registers the task — a deploy line), the job builds
// ONE `weekly_schedule_teacher` row per teacher with ≥ 1 CONFIRMED row in Mon–Sun, send-once by `weekly-teacher:<id>:<weekStart>`,
// and ALWAYS writes a `job_runs` row (TASK-208's lesson: a job never registered on the box must stay visible). A teacher with
// nothing that week gets nothing. No flag: the words are the owner's (REQ-104 §3), not placeholders.
export async function runWeeklyTeacherDigestJob(date?: string) {
  const runDate = date ?? bangkokNow().date;
  const { weekStart, weekEnd } = weekOf(runDate);
  const rows = await db.query.bookings.findMany({
    where: (b: any, { and: a, gte: g, lte: l }: any) => a(g(b.date, weekStart), l(b.date, weekEnd)),
    // TASK-453b — `seats` rides along: the weekly digest's clash note needs the live-seat half of the derivation.
    with: { teacher: true, student: true, coStudent: true, subject: true, seats: true, additionalTeachers: { with: { teacher: true } } },
  });
  const groups = groupWeekRows(rows);
  let sent = 0, skipped = 0, duplicate = 0;
  for (const g of groups) {
    const result = await enqueueLine({
      recipientType: "teacher",
      recipientLineUserId: g.lineUserId,
      payload: { kind: "weekly_schedule_teacher", weekStart, rows: g.rows },
      skipReason: g.lineUserId ? undefined : "ยังไม่ผูก LINE",
      idempotencyKey: weeklyDigestKey(g.teacherId, weekStart),
    });
    if (result.status === "duplicate") duplicate++;
    else if (result.status === "skipped") skipped++;
    else sent++;
  }
  const summary = { weekStart, weekEnd, teachers: groups.length, sent, skipped, duplicate };
  await db.insert(jobRuns).values({ job: WEEKLY_DIGEST_JOB, runDate, status: "success", summary, finishedAt: new Date() });
  return { date: runDate, ...summary };
}

// ─────── TASK-456 (REQ-105 §3) — the ROLLING EXTENDER for group series ───────
//
// A group slot has no end date: it runs every week until an admin CLOSES it (TASK-453's `group_closed_at`). Its rows
// are real bookings, so something has to create them — and "something" being a human who remembers is how a class
// quietly stops existing three weeks out.
//
// The SAME shape as the weekly digest: a Windows Task Scheduler exe (`scripts/group-series-extender.ts`) hits
// `POST /internal/jobs/group-series-extender` daily, and a `job_runs` row is ALWAYS written (TASK-208's lesson — a job
// never registered on the box must stay visible instead of failing silently for weeks).
//
// 🔑 Idempotent BY STATE (`weeklyDatesToCreate` reads the rows that exist), never by a stamp.
// 🔑 ONE DATE PER TRANSACTION, deliberately: a coach-hour that is taken on one Tuesday must not stop every OTHER
// series from being extended. The clash is reported in the run's summary and the log line, and the run continues.
/**
 * 🔴 TASK-462 — the bounds. A FIRST run on an old box is the biggest run this job will ever do (every live series nobody
 * closed, up to N weeks each), and `sid` was exactly that box. So a run can be taken in BITES: when it reaches a bound it
 * stops, says so, and the next run continues — for free, because the job is idempotent by state.
 * 📌 Only series WITH work count against `maxSeries`: counting the complete ones would let the first fifty finished
 * series eat the budget on every run, and the fifty-first would never be reached.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const EXTENDER_DEFAULT_MAX_SERIES = 25;
export const EXTENDER_DEFAULT_MAX_DATES = 100;
export interface ExtenderOpts { apply?: boolean; maxSeries?: number; maxDates?: number }
export interface ExtenderPlanItem { groupKey: string; title: string | null; teacherId: string; coach: string | null; dates: string[] }

/**
 * What the extender WOULD do — the whole decision, and nothing else. Reads only. 🚫 The rules are unchanged from
 * TASK-456: `weeklyDatesToCreate` from the series' own rows, the LAST row as the template, a CLOSED series skipped.
 */
export async function planGroupSeriesExtension(runDate: string, opts: ExtenderOpts = {}) {
  const maxSeries = opts.maxSeries ?? EXTENDER_DEFAULT_MAX_SERIES;
  const maxDates = opts.maxDates ?? EXTENDER_DEFAULT_MAX_DATES;
  // 🔴 TASK-465 — this was `Number(await getSetting(…))`: the whole resolved OBJECT fed to `Number()` ⇒ `NaN`. Mine
  // (TASK-456), and my tests spied the setting to a bare `2`, so they could never see it.
  const weeks = await getNumberSetting("group_series_weeks_ahead");
  const horizon = addDays(runDate, weeks * 7);
  // A job that cannot compute its horizon has BROKEN — it must fail loudly, never report a green zero with `weeks: null`.
  if (!ISO_DATE.test(horizon)) throw new Error(`[${GROUP_EXTENDER_JOB}] horizon is not a date ("${horizon}") — runDate=${runDate} weeks=${weeks}`);
  // 🔴 TASK-466 — ONE read of EVERY group row, any status, split in memory into two questions:
  //  · "which dates has this series ever HAD?" ⇒ ALL rows (live, cancelled, attended). This used to be the live rows
  //    only, so a date an admin CANCELLED was invisible here — and if it was the series' last date, the anchor fell back
  //    to the last live row and the job re-created the cancelled session that night (a CANCELLED row holds no slot, so
  //    nothing clashed and nothing complained). The TASK-456 reasoning that removed the "already exists" guard was
  //    sound about LIVE rows; it was the wrong set.
  //  · "does this series still run, and what does it look like now?" ⇒ the LIVE rows, exactly as before: a series with
  //    no live row left (cancelled in full) is not iterated at all — a cancel-all stays terminal — and the template is
  //    still the last LIVE row, because a cancelled row is not what the class looks like today.
  const rows = await db.query.bookings.findMany({
    where: (b: any, { eq: e }: any) => e(b.bookingType, "GROUP"),
    with: { additionalTeachers: true, teacher: true },
    orderBy: (b: any, { asc }: any) => [asc(b.date)],
  });
  const series = new Map<string, any[]>(); // live rows, by key
  const hadDates = new Map<string, string[]>(); // EVERY date the series has had, any status, by key
  for (const r of rows) {
    if (!r.groupKey) continue;
    hadDates.set(r.groupKey, [...(hadDates.get(r.groupKey) ?? []), r.date]);
    if (COURSE_LIVE.has(r.status)) series.set(r.groupKey, [...(series.get(r.groupKey) ?? []), r]);
  }

  const plan: Array<ExtenderPlanItem & { template: any }> = [];
  let closed = 0, planned = 0, pending = 0;
  let truncated: null | { bound: "maxSeries" | "maxDates"; limit: number; seriesNotReached: number } = null;
  for (const [groupKey, group] of series) {
    // 🚫 A CLOSED series gains nothing — that is what closing is FOR, and it is the only off switch. ⚠️ Said plainly:
    // a series somebody ABANDONED without closing WILL keep being extended. That is the design, not an oversight.
    if (group.some((r: any) => r.groupClosedAt)) { closed++; continue; }
    // 🔑 TASK-466 — the ANCHOR is the last date the series ever HAD (cancelled ones included): a cancelled session is a
    // cancelled session, not the end of a weekly class. Anchoring on the last LIVE date instead would re-create the
    // cancelled dates — and would silently shorten nothing, it would REPEAT them.
    const dates = weeklyDatesToCreate({ existing: hadDates.get(groupKey) ?? [], from: runDate, horizon });
    if (!dates.length) continue;
    // 🔴 TASK-462 — the bound is checked BEFORE the series is taken, and a series is never split across runs: half a
    // series extended is a series whose later weeks look missing to a human reading the calendar.
    if (!truncated && plan.length >= maxSeries) truncated = { bound: "maxSeries", limit: maxSeries, seriesNotReached: 0 };
    if (!truncated && planned + dates.length > maxDates && plan.length > 0) truncated = { bound: "maxDates", limit: maxDates, seriesNotReached: 0 };
    if (truncated) { truncated.seriesNotReached++; pending += dates.length; continue; }
    const t = group[group.length - 1]!; // the LAST row is the template: the series as it stands today, not as it began
    const title = displayNameOf(t) || null; // TASK-423's ONE name rule — a GROUP row's name is its title
    plan.push({ groupKey, title, teacherId: t.teacherId, coach: t.teacher?.nickname ?? t.teacher?.name ?? null, dates, template: t });
    planned += dates.length;
  }
  return { runDate, horizon, weeks, series: series.size, closedSkipped: closed, plan, planned, truncated, datesNotReached: pending, maxSeries, maxDates };
}

/**
 * The extender. 🔴 TASK-462 — **`apply` defaults to FALSE.** A human poking the endpoint by hand gets the plan and
 * nothing is written (the repo's own convention for anything that writes — `ensure-subjects`, `backfill-other-series`,
 * `line-relink-menus`); the nightly trigger sends `{"apply":true}` explicitly. 📌 A dry run writes NOTHING, not even
 * a `job_runs` row: "writes nothing" is the promise, and a human's look is not the scheduled run.
 */
export async function runGroupSeriesExtenderJob(date?: string, opts: ExtenderOpts = {}) {
  const runDate = date ?? bangkokNow().date;
  const p = await planGroupSeriesExtension(runDate, opts);
  const report = {
    date: runDate, horizon: p.horizon, weeks: p.weeks, series: p.series, closedSkipped: p.closedSkipped,
    wouldCreate: p.planned, truncated: p.truncated, datesNotReached: p.datesNotReached,
    plan: p.plan.map(({ template: _t, ...item }) => item),
  };
  if (!opts.apply) return { dryRun: true as const, ...report };

  let created = 0, extended = 0;
  const clashes: Array<{ groupKey: string; date: string; message: string }> = [];
  for (const item of p.plan) {
    const t = item.template;
    const extras = (t.additionalTeachers ?? []).map((a: any) => a.teacherId as string);
    const rates: Record<string, number> = {};
    if (t.teacherRateMinor != null) rates[t.teacherId] = t.teacherRateMinor;
    for (const a of t.additionalTeachers ?? []) if (a.rateMinor != null) rates[a.teacherId] = a.rateMinor;
    let any = false;
    for (const d of item.dates) {
      try {
        await db.transaction(async (tx) => {
          const id = await insertBooking(tx, null, {
            teacherId: t.teacherId, subjectId: null, date: d, startTime: hhmm(t.startTime), bookingType: "GROUP",
            otherTitle: t.otherTitle, otherKind: t.otherKind, headCount: t.headCount, groupKey: item.groupKey, teacherRates: rates,
          });
          if (extras.length) await attachAdditionalTeachers(tx, id, extras, rates);
        });
        created++; any = true;
      } catch (e) {
        // One date, one transaction: this date is not created, every other one still is.
        clashes.push({ groupKey: item.groupKey, date: d, message: e instanceof ApiException ? e.message : String(e) });
      }
    }
    if (any) extended++;
  }
  if (clashes.length) console.warn(`[${GROUP_EXTENDER_JOB}] ${runDate} ${clashes.length} date(s) could not be created:`, clashes);
  if (p.truncated) console.warn(`[${GROUP_EXTENDER_JOB}] ${runDate} stopped at ${p.truncated.bound}=${p.truncated.limit} — ${p.truncated.seriesNotReached} series / ${p.datesNotReached} date(s) left for the next run`);
  const { plan: _plan, ...rest } = report;
  return { dryRun: false as const, ...rest, extended, created, clashes };
}

/** One apply at a time in this process — a second trigger while one runs answers 409 rather than doubling the writes. */
let extenderRunning: string | null = null;

/**
 * 🔴 TASK-462 — the APPLY path as the route runs it: a `job_runs` row is written FIRST (`status: "running"`, no
 * `finished_at`), the caller gets its id at once, and the work continues detached, finishing that same row as
 * `success` or `failed`.
 *
 * 🔑 That row is what makes "it ran long" and "the process died" DIFFERENT things to a human: a long run is a
 * `running` row that later finishes; a dead process is a `running` row that NEVER does. Before this, both were the
 * same "the underlying connection was closed" in PowerShell — which is how `sid`'s incident became unreadable.
 * (TASK-460's `[line-in]`-without-`FINISH`, one layer up.)
 */
export async function startGroupSeriesExtenderRun(date: string | undefined, opts: ExtenderOpts): Promise<{ runId: string; status: "running" } | { alreadyRunning: string }> {
  if (extenderRunning) return { alreadyRunning: extenderRunning };
  const runDate = date ?? bangkokNow().date;
  const [row] = await db.insert(jobRuns).values({ job: GROUP_EXTENDER_JOB, runDate, status: "running", summary: { apply: true, maxSeries: opts.maxSeries ?? EXTENDER_DEFAULT_MAX_SERIES, maxDates: opts.maxDates ?? EXTENDER_DEFAULT_MAX_DATES } }).returning({ id: jobRuns.id });
  const runId = row!.id;
  extenderRunning = runId;
  void (async () => {
    try {
      const out = await runGroupSeriesExtenderJob(runDate, { ...opts, apply: true });
      await db.update(jobRuns).set({ status: "success", summary: out as any, finishedAt: new Date() }).where(eq(jobRuns.id, runId));
    } catch (e) {
      console.error(`[${GROUP_EXTENDER_JOB}] run ${runId} FAILED:`, e);
      // best effort: if the database is the thing that failed, this write fails too — and the row stays `running`
      // with no `finished_at`, which is itself the honest record of "the run did not finish".
      await db.update(jobRuns).set({ status: "failed", summary: { error: String(e) }, finishedAt: new Date() }).where(eq(jobRuns.id, runId)).catch((e2) => console.error(`[${GROUP_EXTENDER_JOB}] could not record the failure of run ${runId}:`, e2));
    } finally {
      extenderRunning = null;
    }
  })();
  return { runId, status: "running" };
}

// ─────── TASK-467 — a READ-ONLY window into `job_runs` ───────
//
// TASK-462 moved a job's outcome out of the PowerShell window into a `job_runs` row — so that "it ran long" and "it
// died" stop looking identical — and gave the owner no way to read that row. This is the window: newest first, capped,
// and nothing else. 🔑 A `running` row with no `finishedAt` is returned EXACTLY as it is: an unfinished run must read as
// unfinished, because that absence is the signal the whole TASK-462 design rests on.
export const JOB_RUNS_DEFAULT_LIMIT = 20;
export const JOB_RUNS_MAX_LIMIT = 100;
export async function listJobRuns(opts: { job?: string; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? JOB_RUNS_DEFAULT_LIMIT, JOB_RUNS_MAX_LIMIT);
  const rows = await db
    .select()
    .from(jobRuns)
    .where(opts.job ? eq(jobRuns.job, opts.job) : undefined)
    .orderBy(desc(jobRuns.startedAt))
    .limit(limit);
  return {
    runs: rows.map((r: any) => ({ job: r.job, runId: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt ?? null, summary: r.summary ?? null })),
  };
}
