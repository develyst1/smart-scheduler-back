// 🔻 TASK-735 / TASK-736 — the camp's FIXED hours per half, ONE map for every message that prints them (the family's camp-day reminder, TASK-736; the family's «camp booked» confirm,
// TASK-735). Decided by the CEO (ฟีน), 2026-10-12: morning 10:00-12:00 · afternoon 13:00-15:00 · all day 10:00-15:00. Times print with a COLON (the set-1 house rule), never Khwan's dot.
// 🚫 Not the camp week's `windowStart`/`windowEnd` (a per-week/per-coach teaching window, `camp.ts`): what the FAMILY is told is fixed by half.
export const CAMP_HALF_HOURS = { AM: "10:00-12:00", PM: "13:00-15:00", FULL: "10:00-15:00" } as const;

/** The hours a family is told for a camp half (`AM` | `PM` | `FULL`); an unknown value ⇒ `undefined` (the caller omits the line — never a guess). */
export function campHoursOf(half: string | null | undefined): string | undefined {
  return half && Object.prototype.hasOwnProperty.call(CAMP_HALF_HOURS, half) ? CAMP_HALF_HOURS[half as keyof typeof CAMP_HALF_HOURS] : undefined;
}
