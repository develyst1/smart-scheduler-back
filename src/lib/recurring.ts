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

/**
 * FIX-007 / TASK-195 — expiry for a course **imported mid-way**, from the owner's rule.
 *
 * ```
 * realStart  = firstRemainingSession − (priorSessions × 1 week)
 * expiryDate = realStart + MAX_WEEK_BY_SIZE[size] weeks
 * ```
 *
 * 🔴 The import path used to **take** `expiryDate` from the caller, under a comment arguing that computing it
 * would "silently extend or shorten what the family bought". That reasoning was reasonable and is now
 * **overruled by the owner**: a typed-in date is not what the family bought either, it is what somebody typed,
 * and it decides whether a course reads `EXPIRED` — so it must come from the same rule as every other course.
 *
 * The weekly reconstruction is the point: an imported course's sessions run weekly, so `priorSessions` weeks
 * before the first remaining one **is** the real start, and the ceiling then counts from there exactly as it
 * does for a native course. One rule, two entry points.
 *
 * Worked example (the owner's): 10-session, 4 already taught, first remaining 2026-02-05
 *   → realStart 2026-01-08 → expiry 2026-01-08 + 13 weeks = **2026-04-09**.
 *
 * Pure. `priorSessions` is clamped at 0 so a nonsense import cannot push expiry into the future.
 */
export function importedCourseExpiry(
  firstRemainingSession: string,
  size: number,
  priorSessions: number,
): string {
  const prior = Math.max(0, Math.floor(priorSessions));
  const realStart = addDays(firstRemainingSession, -prior * 7);
  return courseExpiry(realStart, size);
}

/** Weekday 0=Sun … 6=Sat of an ISO date (Asia/Bangkok, server TZ). */
export function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00`).getDay();
}
