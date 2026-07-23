// Local freelance budget math (SPEC-005) — pure, so the cap/draw logic is unit-testable without a DB.
// All values in satang. Bookings are 1h, so a job costs exactly `rateMinor`.

/** Draw one job's rate from the remaining budget. Blocked when it wouldn't fit and no override;
 *  under override the remaining may go negative. */
export function freelanceDraw(
  remainingMinor: number,
  rateMinor: number,
  override: boolean,
): { blocked: boolean; remainingAfter: number } {
  if (remainingMinor < rateMinor && !override) {
    return { blocked: true, remainingAfter: remainingMinor };
  }
  return { blocked: false, remainingAfter: remainingMinor - rateMinor };
}

/** Budget exhausted → the calendar hides the teacher (FE folds into `bookable`). */
export const overLimit = (remainingMinor: number) => remainingMinor <= 0;
