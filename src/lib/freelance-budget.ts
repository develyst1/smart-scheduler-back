// Local freelance ceiling math (REQ-006 / TASK-024) — pure, unit-testable. The freelance ceiling is a
// `bo.item` in hours; a 1h booking draws one unit. Remaining may go negative under an admin override.

/** Draw one hour from the remaining ceiling. Blocked when < 1 remaining and no override. */
export function drawCeilingHour(
  remainingQty: number,
  override: boolean,
): { blocked: boolean; remainingAfter: number } {
  if (remainingQty < 1 && !override) {
    return { blocked: true, remainingAfter: remainingQty };
  }
  return { blocked: false, remainingAfter: remainingQty - 1 };
}

/** Ceiling exhausted → the calendar hides the teacher (FE folds into `bookable`). */
export const overLimit = (remainingQty: number) => remainingQty <= 0;

/**
 * Does a teacher edit end their freelance arrangement, so the monthly ceiling must be closed?
 * (REQ-009 / TASK-060.) Pure, so the carve-outs are pinned independently of the DB write:
 * only **FREELANCE → something else** qualifies — FT↔PT, FREELANCE→FREELANCE, and an edit that doesn't
 * touch the type (`newType` undefined) all leave the ceiling alone.
 */
export const shouldCloseCeiling = (
  currentType: string,
  newType: string | undefined,
): boolean => newType !== undefined && currentType === "FREELANCE" && newType !== "FREELANCE";

// ── Reconcile-to-target invariant (REQ-006 / TASK-028) ──────────────────────────────────────────
// A freelance booking holds exactly one hour while its status is "consuming" and zero otherwise.
// Drawing/refunding is driven by this target vs. the hours currently held (derived from the ledger),
// never by the raw action — so any status round-trip is idempotent and can't inflate `remaining`.
// State machine LOCKED by คุณฟีน (2026-07-20, via Porter): SICK_LEAVE *keeps* the draw; NO_SHOW releases.

/** Booking statuses for which the center pays the freelance → the booking holds 1 ceiling hour. */
const FREELANCE_CONSUMING_STATUSES = new Set(["CONFIRMED", "ATTENDED", "SICK_LEAVE", "EXTENDED"]);

/** true → paying (holds 1h); false → not paying (holds 0h). Releasing: NO_SHOW / CANCELLED / PENDING. */
export const isFreelanceConsuming = (status: string) => FREELANCE_CONSUMING_STATUSES.has(status);

/** Hours a booking should hold given its status: 1 when consuming, 0 when releasing. */
export const heldTarget = (status: string): 0 | 1 => (isFreelanceConsuming(status) ? 1 : 0);

/** Change in held hours to reconcile a booking to its status. >0 draws, <0 refunds, 0 = no-op. */
export const reconcileDelta = (held: number, status: string): number => heldTarget(status) - held;

/**
 * New `remaining` after moving held by `delta` (movement qty = −delta, so remaining += −delta).
 * A refund (delta<0) is clamped to never push remaining above the ceiling; a draw may go negative
 * (admin override) and is left un-clamped.
 */
export function reconcileRemaining(remaining: number, ceiling: number, delta: number): number {
  const next = remaining - delta;
  return delta < 0 ? Math.min(next, ceiling) : next;
}
