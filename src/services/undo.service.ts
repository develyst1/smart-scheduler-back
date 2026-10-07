// TASK-492 (SPEC-094, owner rulings 09-25/09-26, Sober's contract ruling) — the admin UNDO: a mistaken leave, a false check-in.
// 💰 The money work. ONE transaction or nothing. The rules are `lib/booking-undo.ts` (pure, pinned by value); this applies them.
//
// 🔑 THE GUARD IS THE ROW'S OWN STATUS: every check before it is a READ; then ONE conditional update
// (`… WHERE id = $1 AND status = <the status it was read with>`). Zero rows ⇒ something else changed it first ⇒ refused, and
// NOTHING else is written — no counter, no make-up, no expiry, no record. That is what makes a double-click, a retry and two
// admins at once all harmless (TASK-480's shape: the state is the permission). Every other write comes after that row.
// 🚫 Silent to the FAMILY — except 🔻 TASK-704: it IS told when the Undo cancels a CONFIRMED (announced) make-up — and to everyone on a check-in Undo (owner ruling 2). 🔔 A LEAVE Undo tells the COACHES — the
// primary and every additional teacher — that the class is on again (TASK-508, owner: yes, never the family) — and, when it
// cancels the leave's make-up, every coach of THAT class that it is off (TASK-510).
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, coursePackages, SLOT_INACTIVE_STATUSES } from "../db/schema"; // TASK-497: `bookingUndos` / `vouchers` now written by the shared `attendance-revert.service`
import { ApiException, notFound } from "../lib/http";
import { bangkokNow } from "../lib/bangkok-time";
import { reverseBookingSale } from "../lib/sale-post";
import { hhmm } from "../lib/time";
import { enqueueLine } from "../lib/line";
import { teachersOfBooking } from "../lib/own-scope";
import {
  UNDO_ALREADY_CHANGED, UNDO_DAY_SETTLED, UNDO_PLAN_WOULD_CHANGE, UNDO_SLOT_TAKEN,
  leaveChargeOf, makeupDecision, undoKindOf, type UndoKind,
} from "../lib/booking-undo";
import { displayNameOf } from "../db/mappers";
import { recordUndo, revertAttendance } from "./attendance-revert.service"; // TASK-497 — the shared writes
import { leaveNoteUndo } from "../lib/leave-note"; // TASK-540
import { MAKEUP_NOTE_UNDONE } from "../lib/makeup-marker"; // TASK-702
import { assertNoCoachOnLeave } from "../lib/teacher-leave"; // TASK-561
import { assertCourseWritable, assertNotCampRow, loadBookingDTO, reconcileBookingHolds, reconcileCoursePlan, sendClassCancelledToCoaches, sendClassCancelledToFamilies } from "./scheduler.service";

/** The note a leave Undo writes on the make-up it cancels — and the `Reason` its coaches read (TASK-510: one string, both). */
const MAKEUP_UNDONE_NOTE = MAKEUP_NOTE_UNDONE; // 🔻 TASK-702 — ONE list (lib/makeup-marker.ts): the migration's P4 reads the same bytes

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
}; // 🔻 TASK-657 §R — no `expiry`: the Undo never moves it (the field was read by nobody — the front's UndoControl only mentions it in a comment)

export type UndoPlan = {
  row: any;
  kind: UndoKind;
  leaveRefunded: boolean;
  makeup: { id: string; status: string; date: string; teacherId: string } | null;
};

/**
 * 🔴 TASK-546 — THE Undo's decision: every read and every refusal, and NO write. Lifted VERBATIM from `undoBooking` (which now
 * calls it and then writes) so the dialog's preview and the act are the SAME reads — they cannot disagree, because they are one
 * function. ⚠️ ONE refusal is not here, and cannot be without changing the act: `UNDO_PLAN_WOULD_CHANGE` is decided AFTER the
 * writes (the reconcile is asked whether the plan balances). A preview can say "ok" where the act then refuses on that check.
 */
export async function planUndo(tx: any, bookingId: string, today: string): Promise<UndoPlan> {
    // 🔻 §T-G — `student` + `coStudent` join the SAME `with`: `displayNameOf` reads them, and the refusal below names the
    // course by whose it is. 🚫 No second query — the row was already being loaded with its relations.
    const row = await tx.query.bookings.findFirst({ where: (b: any, { eq: e }: any) => e(b.id, bookingId), with: { course: true, voucher: true, student: true, coStudent: true } });
    if (!row) throw notFound("ไม่พบคาบเรียน");
    assertNotCampRow(row); // a camp hour: camp has its own day undo
    const kind = undoKindOf(row);
    if (await isDaySettled(tx, row.date, today)) throw UNDO_DAY_SETTLED(row.date); // 🔨 Q1: HARD refusal, no override
    await assertCourseWritable(tx, row.courseId); // TASK-185/198: the ONE guard — nothing revives on an ENDED or a PAUSED course

    // ── the READS that decide everything (no write yet) ──
    let leaveRefunded = false;
    let makeup: { id: string; status: string; date: string; teacherId: string } | null = null;
    if (kind === "leave") {
      await assertNoCoachOnLeave(tx, row); // TASK-561 — the class does not come back onto its coach's advance-leave day
      const linkedAll = row.courseId
        ? await tx.query.bookings.findMany({ where: (b: any, { eq: e }: any) => e(b.extendedFromId, row.id) })
        : [];
      // 🔻 TASK-657 §R — one COUNT given back when the leave was counted (a plain count now); the "unknown" refusal dissolved with the quota.
      leaveRefunded = leaveChargeOf(row) === "charged";

      const live = linkedAll.filter((m: any) => m.status !== "CANCELLED");
      const settled = new Map<string, boolean>();
      for (const m of live) settled.set(m.date, await isDaySettled(tx, m.date, today));
      const d = makeupDecision(live.map((m: any) => ({ id: m.id, status: m.status, date: m.date })), (date) => settled.get(date) === true);
      if (d.action === "cancel") makeup = live.find((m: any) => m.id === d.makeup.id);

      // 🔻 TASK-657 §R (REQ-112) — the EXPIRY block that stood here (read the course's rows, the latest expiry change and the recording marker, then
      // decide whether to hand a week back) is DELETED. The Undo never changes `expiryDate` and writes no expiry-change row.

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
    return { row, kind, leaveRefunded, makeup };
}

/**
 * 🔴 TASK-546 — the Undo dialog's DRY RUN: `planUndo` over the live rows, NOTHING written (no transaction, no write call on
 * this path). A SNAPSHOT — the act stays authoritative and re-plans on the click; it never trusts a preview. A refusal comes back
 * in the act's own words (`ok: false`), except "not found", which stays the 404 it is.
 */
export async function previewUndo(bookingId: string, exec: any = db) {
  try {
    const p = await planUndo(exec, bookingId, bangkokNow().date);
    return {
      ok: true as const,
      kind: p.kind,
      leaveRefunded: p.leaveRefunded,
      makeupCancelled: p.makeup ? { id: p.makeup.id, date: p.makeup.date } : null,
    }; // 🔻 TASK-657 §R — the expiry line is DROPPED from the preview (nothing to say: the Undo never moves it)
  } catch (e) {
    if (e instanceof ApiException && e.status !== 404) return { ok: false as const, code: e.code, message: e.message };
    throw e;
  }
}

export async function undoBooking(bookingId: string, opts: { actor: string | null; reason: string | null }) {
  const today = bangkokNow().date;
  const result: UndoResult = await db.transaction(async (tx: any) => {
    // 🔻 TASK-546 — the READS that decide everything, lifted VERBATIM into `planUndo` (the preview runs the same function).
    const { row, kind, leaveRefunded, makeup } = await planUndo(tx, bookingId, today);

    // ── 🔑 THE GUARD: one conditional update on the status the row was read with (a check-in's is the shared `revertAttendance`) ──
    if (kind === "leave") {
      const flipped = await tx
        .update(bookings)
        .set({ status: "CONFIRMED", leaveCharged: null, ...leaveNoteUndo(row) }) // 🔻 TASK-540 — the note the leave replaced comes back (only if it recorded one)
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
      // rule). In the transaction, as TASK-508's send: the notice exists iff the Undo committed — and, like it, AFTER every refusal.
      // 🔻 TASK-704 (REQ-115 F1) — and the FAMILY, when the make-up was CONFIRMED + marked: it was announced at birth (TASK-702), so a family holding it must be told it is gone ("never the
      // family" was right only while make-ups were born unannounced). An EXTENDED make-up was never announced ⇒ coaches only, as before. The ORIGINAL class coming back stays silent to the family (not built here).
      if (makeup && (makeup.status === "EXTENDED" || makeup.status === "CONFIRMED")) {
        const full = { ...(makeup as any), course: row.course ?? null, voucher: row.voucher ?? null };
        await sendClassCancelledToCoaches(tx, full, { cancelReason: null, note: MAKEUP_UNDONE_NOTE });
        if (makeup.status === "CONFIRMED" && (makeup as any).isMakeup === true) await sendClassCancelledToFamilies(tx, full, null, []);
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
    }); // 🔻 TASK-657 §R — `expiryFrom`/`expiryTo` are no longer written (the columns stay, null — the history of the old rule is not rewritten)
    return { kind, leaveRefunded, makeupCancelledId: makeup?.id ?? null };
  });

  // A posted sale for the false attendance is reversed AFTER the commit: `reverseBookingSale` writes through `db`, outside any
  // transaction, so calling it inside would leave a reversal behind if the Undo rolled back. Best-effort and idempotent on its
  // own key, as in TASK-258.
  if (result.kind === "checkin") await reverseBookingSale(bookingId);
  return { ...result, booking: await loadBookingDTO(db, bookingId) };
}
