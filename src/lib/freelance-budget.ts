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
