// SPEC-028 / TASK-148 rework — where an appended make-up lands: the next weekly slot at the same time that is
// free, stepping a week at a time. Pure: the caller decides what "occupied" means (a DB clash for the save; a
// DB clash **plus** the dates this run already claimed for the preview), so both paths share ONE placement rule
// instead of the preview quietly reimplementing a naive `+7` and disagreeing with what the save will do.
import { addDays } from "./time";

export const MAX_EXTENSION_WEEKS_SCANNED = 26;

export async function firstFreeWeeklySlot(
  fromDate: string,
  isOccupied: (date: string) => boolean | Promise<boolean>,
  maxWeeks: number = MAX_EXTENSION_WEEKS_SCANNED,
): Promise<string> {
  let d = addDays(fromDate, 7);
  for (let i = 0; i < maxWeeks; i++) {
    if (!(await isOccupied(d))) return d;
    d = addDays(d, 7);
  }
  // 🔻 TASK-309 §3 — scanned half a year and found nothing free: hand back the last candidate anyway.
  //
  // This comment used to say *"the caller's ceiling guard (`exceedsExtensionCeiling`) is what refuses it —
  // this function never silently invents a valid-looking date."* 🔴 **`REQ-085 §12` deleted that guard**
  // (TASK-308): the quota is the only gate on leave, and the expiry stretches to fit. ⇒ **for one day this
  // function did exactly what its comment promised it never would.**
  // 🔑 A comment that outlived its mechanism — the third this week, and the only one that was load-bearing.
  //
  // ✅ The answer is not a refusal (`§12` forbids one) and not silence either: **the caller checks
  // `searchExhausted` and TELLS an admin.** *A refusal is the owner's to grant; a warning is ours to owe.*
  return d;
}

/**
 * 🔑 TASK-309 §3 — **did the search give up?**
 *
 * `firstFreeWeeklySlot` returns the last candidate when every week it scanned was occupied, so the only way
 * to tell a found slot from a surrendered one is the DISTANCE: a success lands at or before
 * `from + maxWeeks` weeks; exhaustion lands one week beyond.
 * ⚠️ **This is a FACT, not a threshold.** How far is *too* far is @Porter's to take to the owner — `26` is
 * the only number anyone has written down and it was chosen as a SCAN LIMIT, not as a promise.
 */
export const searchExhausted = (
  fromDate: string,
  landed: string,
  maxWeeks: number = MAX_EXTENSION_WEEKS_SCANNED,
): boolean => landed > addDays(fromDate, maxWeeks * 7);

/** How many whole weeks separate two dates — the fact the warning reports. */
export const weeksBetween = (from: string, to: string): number => {
  let n = 0;
  while (addDays(from, (n + 1) * 7) <= to) n++;
  return n;
};
