// Who may be booked against an existing entitlement (REQ-022 / TASK-051). Pure, so the rule is pinned down
// independently of the query — and stated ONCE, server-side, rather than re-guessed in the browser.
//
// Vouchers already had a rule (`voucherUsable`) — this **reuses** it rather than inventing a second one.
// Courses had no equivalent helper, so `courseEligible` mirrors the same shape from the meaning already implied
// by the course summary (expiry + usedSessions/size).

import { voucherUsable, type VoucherLike } from "./voucher";

export interface CourseLikeEligible {
  size: number;
  usedSessions: number;
  expiryDate: string;
}

/** Sessions left on a course package (never negative). */
export const courseRemainingSessions = (c: CourseLikeEligible): number =>
  Math.max(0, c.size - c.usedSessions);

/**
 * A course can still be booked on `onDate`: sessions remaining **and** not expired.
 *
 * NB: a **leave-locked** course (over its leave quota, not admin-unlocked) is still eligible here — that lock
 * governs further rescheduling/extension, not whether the remaining paid sessions may be booked. Flagged to
 * Sober rather than decided silently.
 */
/**
 * TASK-088 — apply a resolved search to an eligibility list. **`q` narrows; it can never widen.**
 *
 * `matching === null` means "no search term", so everything eligible passes untouched — the no-`q` response
 * must be byte-for-byte what it was. Otherwise a student is kept only if the shared student-search
 * (`studentSearchConditions`, LEFT-joined so a parentless walk-in still matches on name/nickname) returned
 * their id. Pure, so the narrowing rule is testable without a database.
 */
export const matchesSearch = (studentId: string, matching: Set<string> | null): boolean =>
  matching === null || matching.has(studentId);

export const courseEligible =(c: CourseLikeEligible, onDate: string): boolean =>
  courseRemainingSessions(c) > 0 && onDate <= c.expiryDate;

/** Voucher eligibility — delegates to the existing `voucherUsable` rule (hours left + not expired). */
export const voucherEligible = (v: VoucherLike, onDate: string): boolean => voucherUsable(v, onDate).ok;
