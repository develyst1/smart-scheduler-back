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

/**
 * Course expiry — the last date the schedule may reach.
 *
 * 🔴 **`MAX_WEEK_BY_SIZE` is a week NUMBER, not a duration** (TASK-197). Week 1 **is** the start week, so week
 * `N` falls `N − 1` weeks after the start: a 6-session course starting 4 Sep runs to **week 8 = 23 Oct**, not
 * 30 Oct. This used to add the full `weeks`, overshooting **every course by exactly seven days** — a week of
 * schedule nobody bought, on create and on import alike.
 *
 * It survived because the tests asserted `weeks * 7` — the same arithmetic as the code. Layers agreeing with
 * each other is not the same as agreeing with reality; the owner found it by starting one real course. The
 * tests now pin **his** number (`courseExpiry("2026-09-04", 6) === "2026-10-23"`), which is the only kind of
 * assertion that could have caught this.
 */
export function courseExpiry(startDate: string, size: number): string {
  const weekNumber = MAX_WEEK_BY_SIZE[size] ?? size + 1;
  return addDays(startDate, (weekNumber - 1) * 7);
}

/**
 * FIX-007 / TASK-195 — expiry for a course **imported mid-way**, from the owner's rule.
 *
 * ```
 * realStart  = firstRemainingSession − (priorSessions × 1 week)
 * expiryDate = courseExpiry(realStart, size)   // = realStart + (MAX_WEEK_BY_SIZE[size] − 1) weeks
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
 *   → realStart 2026-01-08 → week 13 of that course = 2026-01-08 + 12 weeks = **2026-04-02**.
 *   (This said 04-09 until TASK-197 corrected the off-by-one — the ceiling is a week number, not a duration.)
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

/**
 * The first date on or after `from` that falls on `weekday` (0 = Sunday). Used when a paused course resumes:
 * it comes back on its OWN weekday, not on whatever day the admin happened to click resume.
 */
export function nextWeekdayOnOrAfter(from: string, weekday: number): string {
  const diff = (((weekday - weekdayOf(from)) % 7) + 7) % 7;
  return addDays(from, diff);
}
