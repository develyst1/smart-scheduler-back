// Auto-recurring course package (B.4) — pure scheduling math, unit-testable.
// Registering a 4/6/10-session course locks the same weekday+time forward, one
// session per week. Expiry = start + the size's max-week ceiling (the same window
// the leave/extension rule allows).

import { addDays } from "./time";
import { MAX_WEEK_BY_SIZE } from "./leave";

export const COURSE_SIZES = [4, 6, 10] as const;
export type PackageSize = (typeof COURSE_SIZES)[number];

export const isCourseSize = (n: number): n is PackageSize =>
  (COURSE_SIZES as readonly number[]).includes(n);

/** Weekly session dates: startDate, +7d, +14d … (length = size). */
export function courseSessionDates(startDate: string, size: number): string[] {
  return Array.from({ length: size }, (_, i) => addDays(startDate, i * 7));
}

/** Course expiry = startDate + (max-week ceiling) weeks. 4→5wk, 6→8wk, 10→13wk. */
export function courseExpiry(startDate: string, size: number): string {
  const weeks = MAX_WEEK_BY_SIZE[size] ?? size + 1;
  return addDays(startDate, weeks * 7);
}

/** Weekday 0=Sun … 6=Sat of an ISO date (Asia/Bangkok, server TZ). */
export function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00`).getDay();
}
