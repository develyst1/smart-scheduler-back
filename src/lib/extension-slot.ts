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
  // Scanned half a year and found nothing free: hand back the last candidate. The caller's ceiling guard
  // (`exceedsExtensionCeiling`) is what refuses it — this function never silently invents a valid-looking date.
  return d;
}
