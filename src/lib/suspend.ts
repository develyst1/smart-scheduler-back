// Household suspend rules (REQ-019 / TASK-048). Pure, so the gate is unit-testable and stated once.
//
// Suspend is the ONLY "off" switch — nothing is ever deleted. A suspended parent loses the LINE bot and new
// bookings for their students, but keeps existing bookings, history, students, and full staff visibility.

/** Null/undefined `suspended_at` = active. Any timestamp = suspended. */
export const isSuspended = (suspendedAt: Date | string | null | undefined): boolean =>
  suspendedAt !== null && suspendedAt !== undefined;

/**
 * Should this action be refused because the student's household is suspended?
 *
 * Covers **both** things a suspended household may not do: create a new **booking** (TASK-048) and **buy** a
 * course/voucher (TASK-058). One neutral name rather than a booking- and a purchase-flavoured sibling, so there
 * is exactly one definition of "suspended" to keep correct.
 *
 * A student with **no parent** (walk-in / First-Trial — `students.parent_id` is nullable by design) has no
 * household to suspend, so it is never blocked.
 */
export const blockedBySuspension = (
  parent: { suspendedAt?: Date | string | null } | null | undefined,
): boolean => !!parent && isSuspended(parent.suspendedAt);
