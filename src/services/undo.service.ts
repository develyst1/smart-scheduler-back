// TASK-492 (SPEC-094, owner rulings 09-25/09-26, Sober's contract ruling) — the admin UNDO: a mistaken leave, a false check-in.
// 💰 The money work. ONE transaction or nothing. The rules are `lib/booking-undo.ts` (pure, pinned by value); this applies them.
//
// 🔑 THE GUARD IS THE ROW'S OWN STATUS: every check before it is a READ; then ONE conditional update
// (`… WHERE id = $1 AND status = <the status it was read with>`). Zero rows ⇒ something else changed it first ⇒ refused, and
// NOTHING else is written — no counter, no make-up, no expiry, no record. That is what makes a double-click, a retry and two
// admins at once all harmless (TASK-480's shape: the state is the permission). Every other write comes after that row.
// 🚫 Silent to the FAMILY, always, and to everyone on a check-in Undo (owner ruling 2). 🔔 A LEAVE Undo tells the COACHES — the
// primary and every additional teacher — that the class is on again (TASK-508, owner: yes, never the family) — and, when it
// cancels the leave's make-up, every coach of THAT class that it is off (TASK-510).
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, coursePackages, SLOT_INACTIVE_STATUSES } from "../db/schema"; // TASK-497: `bookingUndos` / `vouchers` now written by the shared `attendance-revert.service`
import { notFound } from "../lib/http";
import { bangkokNow } from "../lib/bangkok-time";
import { reverseBookingSale } from "../lib/sale-post";
import { hhmm } from "../lib/time";
import { enqueueLine } from "../lib/line";
import { teachersOfBooking } from "../lib/own-scope";
import {
  UNDO_ALREADY_CHANGED, UNDO_DAY_SETTLED, UNDO_LEAVE_CHARGE_UNKNOWN, UNDO_PLAN_WOULD_CHANGE, UNDO_SLOT_TAKEN,
  expiryDecision, leaveChargeOf, makeupDecision, undoKindOf, type ExpiryDecision, type UndoKind,
} from "../lib/booking-undo";
import { displayNameOf } from "../db/mappers";
import { recordUndo, revertAttendance } from "./attendance-revert.service"; // TASK-497 — the shared writes
import { assertCourseWritable, assertNotCampRow, loadBookingDTO, reconcileBookingHolds, reconcileCoursePlan, recordExpiryChange, sendClassCancelledToCoaches } from "./scheduler.service";

/** The note a leave Undo writes on the make-up it cancels — and the `Reason` its coaches read (TASK-510: one string, both). */
const MAKEUP_UNDONE_NOTE = "ยกเลิกคาบขยาย — ย้อนกลับการลา";

/**
 * 🔴 SETTLED (Sober's ruling on the contract §C): the date is before today (the day-end never revisits a past date, so a past
 * day is closed whether or not its job row exists), OR a successful `end-of-day` run for that date exists — evidence the job
 * ran, not a clock.
 */
export async function isDaySettled(exec: any, date: string, today: string): Promise<boolean> {
  if (date < today) return true;
  const run = await exec.query.jobRuns.findFirst({
    where: (j: any, { and: a, eq: e }: any) => a(e(j.job, "end-of-day"), e(j.runDate, date), e(j.status, "success")),
  });
  return !!run;
}

export type UndoResult = {
  kind: UndoKind;
  leaveRefunded: boolean;
  makeupCancelledId: string | null;
  expiry: { from: string; to: string } | null;
};

export async function undoBooking(bookingId: string, opts: { actor: string | null; reason: string | null }) {
  const today = bangkokNow().date;
  const result: UndoResult = await db.transaction(async (tx: any) => {
    const row = await tx.query.bookings.findFirst({ where: (b: any, { eq: e }: any) => e(b.id, bookingId), with: { course: true, voucher: true } });
    if (!row) throw notFound("ไม่พบคาบเรียน");
    assertNotCampRow(row); // a camp hour: camp has its own day undo
    const kind = undoKindOf(row);
    if (await isDaySettled(tx, row.date, today)) throw UNDO_DAY_SETTLED(row.date); // 🔨 Q1: HARD refusal, no override
    await assertCourseWritable(tx, row.courseId); // TASK-185/198: the ONE guard — nothing revives on an ENDED or a PAUSED course

    // ── the READS that decide everything (no write yet) ──
    let leaveRefunded = false;
    let makeup: { id: string; status: string; date: string; teacherId: string } | null = null;
    let expiry: ExpiryDecision = { action: "keep" };
    if (kind === "leave") {
      const linkedAll = row.courseId
        ? await tx.query.bookings.findMany({ where: (b: any, { eq: e }: any) => e(b.extendedFromId, row.id) })
        : [];
      const charge = leaveChargeOf(row, linkedAll.length > 0);
      if (charge === "unknown") throw UNDO_LEAVE_CHARGE_UNKNOWN();
      leaveRefunded = charge === "charged";

      const live = linkedAll.filter((m: any) => m.status !== "CANCELLED");
      const settled = new Map<string, boolean>();
      for (const m of live) settled.set(m.date, await isDaySettled(tx, m.date, today));
      const d = makeupDecision(live.map((m: any) => ({ id: m.id, status: m.status, date: m.date })), (date) => settled.get(date) === true);
      if (d.action === "cancel") makeup = live.find((m: any) => m.id === d.makeup.id);

      if (makeup && row.course) {
        const rows = await tx.query.bookings.findMany({
          where: (b: any, { and: a, eq: e, ne: n }: any) => a(e(b.courseId, row.courseId), e(b.bookingType, "COURSE_PACKAGE"), n(b.status, "CANCELLED")),
        });
        const latest = await tx.query.courseExpiryChanges.findFirst({
          where: (c: any, { eq: e }: any) => e(c.courseId, row.courseId),
          orderBy: (c: any) => [desc(c.changedAt)],
        });
        expiry = expiryDecision({
          expiry: row.course.expiryDate,
          makeupDate: makeup.date,
          otherDates: rows.filter((r: any) => r.id !== makeup!.id).map((r: any) => r.date),
          latest: latest ? { fromDate: latest.fromDate, toDate: latest.toDate, actor: latest.actor ?? null } : null,
        });
      }

      // The coach's HOUR: a leave freed it (UC-004), so someone may hold it now. Asked with the unique index's OWN predicate
      // (`SLOT_INACTIVE_STATUSES`, no seat, not yielded) — the one answer to "is this hour free?". A seat holds no slot.
      if (!row.groupId && !row.slotYieldedAt) {
        const holder = await tx.query.bookings.findFirst({
          where: (b: any, { and: a, eq: e, ne: n, notInArray: notIn, isNull: nil }: any) =>
            a(e(b.teacherId, row.teacherId), e(b.date, row.date), e(b.startTime, row.startTime), n(b.id, row.id),
              notIn(b.status, [...SLOT_INACTIVE_STATUSES]), nil(b.groupId), nil(b.slotYieldedAt)),
          with: { student: true, coStudent: true },
        });
        if (holder) throw UNDO_SLOT_TAKEN(`${row.date} ${hhmm(row.startTime)}`, displayNameOf(holder) || "คาบอื่น"); // the ONE name rule
      }
    }

    // ── 🔑 THE GUARD: one conditional update on the status the row was read with (a check-in's is the shared `revertAttendance`) ──
    if (kind === "leave") {
      const flipped = await tx
        .update(bookings)
        .set({ status: "CONFIRMED", leaveCharged: null })
        .where(and(eq(bookings.id, row.id), eq(bookings.status, row.status)))
        .returning({ id: bookings.id });
      if (!flipped.length) throw UNDO_ALREADY_CHANGED();
      // 🔴 The refund: `sql` arithmetic with a FLOOR — never read-modify-write, and the floor makes any double decrement harmless.
      if (leaveRefunded) {
        await tx.update(coursePackages).set({ leaveUsed: sql`GREATEST(${coursePackages.leaveUsed} - 1, 0)` }).where(eq(coursePackages.id, row.courseId));
      }
      if (makeup) {
        const cancelled = await tx
          .update(bookings)
          .set({ status: "CANCELLED", note: MAKEUP_UNDONE_NOTE })
          .where(and(eq(bookings.id, makeup.id), eq(bookings.status, makeup.status as (typeof bookings.status)["_"]["data"])))
          .returning({ id: bookings.id });
        if (!cancelled.length) throw UNDO_ALREADY_CHANGED();
        await reconcileBookingHolds(tx, makeup.id, makeup.teacherId, "CANCELLED", false); // its freelance hour back
      }
      if (expiry.action === "restore") {
        await tx.update(coursePackages).set({ expiryDate: expiry.to }).where(eq(coursePackages.id, row.courseId));
        await recordExpiryChange(tx, { courseId: row.courseId, from: expiry.from, to: expiry.to, actor: opts.actor });
      }
      // The plan must now balance on its own: the reconcile is asked, and must do NOTHING. If it would append or cancel (e.g.
      // this leave's make-up was already trimmed, so undoing it over-plans the course), the Undo is refused — the reconcile
      // trims newest-first and would cancel ANOTHER leave's make-up.
      if (row.courseId) {
        const moves = await reconcileCoursePlan(tx, row.courseId);
        if (moves.appended.length || moves.cancelled.length) throw UNDO_PLAN_WOULD_CHANGE();
      }
      // 🔴 TASK-510 — the make-up was CANCELLED above, and its coaches may not be this class's coaches: tell every coach of the MAKE-UP
      // (its own row, so the date / time / child are the make-up's), with the existing cancel notice. Only a make-up the coach
      // HELD — EXTENDED or CONFIRMED (on their week, TEACHER_VISIBLE); a PENDING one was never announced (the cancel's own
      // rule). In the transaction, as TASK-508's send: the notice exists iff the Undo committed — and, like it, AFTER every refusal. 🚫 Never the family.
      if (makeup && (makeup.status === "EXTENDED" || makeup.status === "CONFIRMED")) {
        await sendClassCancelledToCoaches(tx, { ...(makeup as any), course: row.course ?? null, voucher: row.voucher ?? null }, { cancelReason: null, note: MAKEUP_UNDONE_NOTE });
      }
      // 🔔 TASK-508 — the class is BACK ON, and the coaches are the ones who have to be there. Every teacher of the row through
      // THE predicate (primary + additional, TASK-487). 🔑 INSIDE the transaction, the parent deduction's pattern (TASK-490):
      // the message exists iff the Undo committed — a rollback (a refusal below, a lost race) takes the row with it, and a
      // committed Undo cannot lose its message. It cannot FAIL the Undo on its own: an unlinked coach is a SKIPPED row, never a
      // throw (`enqueueLine`'s contract); the only failure left is the database refusing a write — the same failure that would
      // stop the Undo's own writes. 🚫 Never the family (no parent recipient exists on this path).
      for (const coach of await teachersOfBooking(tx, row.id)) {
        await enqueueLine({
          recipientType: "teacher",
          recipientLineUserId: coach.lineUserId ?? null,
          bookingId: row.id,
          payload: { kind: "class_on_again_teacher", bookingId: row.id, bookingType: row.bookingType ?? null, size: row.course?.size ?? row.voucher?.totalHours ?? null },
        }, tx);
      }
    } else {
      // The false check-in: the guarded flip + its unit back — THE SHARED WRITES (TASK-497), the same ones TASK-258's door runs.
      await revertAttendance(tx, row);
    }
    // The coach's freelance hold for the row's new status (a leave had released it; ATTENDED → CONFIRMED holds the same).
    await reconcileBookingHolds(tx, row.id, row.teacherId, "CONFIRMED", false);

    // The EVENT, append-only — with the original check-in's provenance kept (owner ruling 2). The shared writer (TASK-497).
    await recordUndo(tx, row, {
      kind,
      undoneBy: opts.actor,
      reason: opts.reason,
      leaveRefunded,
      makeupCancelledId: makeup?.id ?? null,
      expiryFrom: expiry.action === "restore" ? expiry.from : null,
      expiryTo: expiry.action === "restore" ? expiry.to : null,
    });
    return { kind, leaveRefunded, makeupCancelledId: makeup?.id ?? null, expiry: expiry.action === "restore" ? { from: expiry.from, to: expiry.to } : null };
  });

  // A posted sale for the false attendance is reversed AFTER the commit: `reverseBookingSale` writes through `db`, outside any
  // transaction, so calling it inside would leave a reversal behind if the Undo rolled back. Best-effort and idempotent on its
  // own key, as in TASK-258.
  if (result.kind === "checkin") await reverseBookingSale(bookingId);
  return { ...result, booking: await loadBookingDTO(db, bookingId) };
}
