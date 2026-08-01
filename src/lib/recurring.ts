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

/**
 * Sessions still owed on an imported entitlement (SPEC-025 / TASK-079) — **the balance, not the history**.
 *
 * Never negative: a course whose `used` already meets or exceeds `size` is finished, so it imports with
 * **zero** future bookings rather than being refused — staff may still want the record. Guarding here rather
 * than at the call site is what stops `size - used` becoming a negative loop bound.
 */
export function remainingSessions(size: number, used: number): number {
  return Math.max(0, Math.floor(size) - Math.max(0, Math.floor(used)));
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
