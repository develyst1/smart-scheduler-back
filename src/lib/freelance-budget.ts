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
 * TASK-091 — **which item** holds a booking's hour, as opposed to how many hours it holds.
 *
 * The invariant: a booking holds **at most one hour, on exactly one item — the current teacher's** — whatever
 * it held before. `reconcileFreelanceDraw` was written for *status* changes, where the teacher never moves, so
 * it only ever looks at one item. A **teacher** change is a different event: the hour is held on someone
 * else's item, which that function cannot see. Moving A→B therefore left A drawn for a session they don't
 * teach **and** B undrawn — so B could be booked past their ceiling, which is what the cap exists to prevent.
 *
 * Stated as "release anything that isn't the current teacher, then reconcile the current teacher to target",
 * it is correct for **any** number of teacher changes and collapses to today's behaviour when the teacher
 * hasn't moved (no foreign holds ⇒ a single adjustment, exactly as before).
 *
 * ⚠️ Deliberately does NOT decide *how many* hours a status holds — that stays `heldTarget`/`reconcileDelta`.
 * This only answers *where*.
 *
 * @param holds       every freelance item currently holding this booking, with its net held hours
 * @param currentItemId the current teacher's ceiling item, or `null` when they have none (FT/PT, or no ceiling)
 * @param target      hours the booking should hold now — always `heldTarget(status)`, never re-derived here
 */
export function planHoldMoves(
  holds: Array<{ itemId: string; held: number }>,
  currentItemId: string | null,
  target: number,
): Array<{ itemId: string; delta: number }> {
  const moves: Array<{ itemId: string; delta: number }> = [];

  // Release every item that is holding this booking but is not the current teacher's.
  for (const h of holds) {
    if (h.itemId !== currentItemId && h.held !== 0) moves.push({ itemId: h.itemId, delta: -h.held });
  }

  // Then bring the current teacher's item to target. `null` = nobody to draw on (moved to FT/PT), which is
  // why the releases above are unconditional rather than paired with a draw.
  if (currentItemId !== null) {
    const held = holds.find((h) => h.itemId === currentItemId)?.held ?? 0;
    const delta = target - held;
    if (delta !== 0) moves.push({ itemId: currentItemId, delta });
  }

  return moves;
}

/**
 * New `remaining` after moving held by `delta` (movement qty = −delta, so remaining += −delta).
 * A refund (delta<0) is clamped to never push remaining above the ceiling; a draw may go negative
 * (admin override) and is left un-clamped.
 */
export function reconcileRemaining(remaining: number, ceiling: number, delta: number): number {
  const next = remaining - delta;
  return delta < 0 ? Math.min(next, ceiling) : next;
}
