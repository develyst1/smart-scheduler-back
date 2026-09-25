// Check-in token + time-window rules (C.1). Pure helpers — no DB.

import { bangkokNow, timeToMinutes } from "./bangkok-time";
import { hhmm } from "./time";

/** Minutes before class start that check-in opens (e.g. 30 min early). */
export const CHECKIN_EARLY_MINUTES = 30;

/** TASK-474 — the late window's hard ceiling (the setting's own range; enforced HERE too — a setting is a number a human types). */
export const CHECKIN_LATE_MINUTES_MAX = 180;
const LAST_MINUTE_OF_DAY = 23 * 60 + 59;

/**
 * 🔴 TASK-474 — the window's END in minutes: the class end + the late minutes, clamped to 0–180 and to 23:59 of the SAME day.
 * Sober's ruling 1: the whole check-in path matches a booking on TODAY's date, so a window past midnight would silently
 * match nothing — the arithmetic must never be able to imply tomorrow. `lateMinutes` 0 ⇒ exactly the class end.
 */
export function lateWindowEnd(endTime: string, lateMinutes = 0): number {
  const late = Math.min(Math.max(0, Math.floor(Number.isFinite(lateMinutes) ? lateMinutes : 0)), CHECKIN_LATE_MINUTES_MAX);
  return Math.min(timeToMinutes(hhmm(endTime)) + late, LAST_MINUTE_OF_DAY);
}
const hhmmOf = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export function generateCheckinToken(): string {
  // 24 hex chars — enough entropy for a one-day token
  return crypto.randomUUID().replace(/-/g, "");
}

/** True when Bangkok wall-clock is inside [start−early, end+late] on the booking date. `earlyMinutes` defaults to the
 *  coded constant; the check-in service resolves the `checkin_early_minutes` setting and passes it (SPEC-029).
 *  TASK-474 — `lateMinutes` (the `checkin_late_minutes` setting, default 0) widens the END, same day only. */
export function isWithinCheckinWindow(
  bookingDate: string,
  startTime: string,
  endTime: string,
  now = bangkokNow(),
  earlyMinutes: number = CHECKIN_EARLY_MINUTES,
  lateMinutes = 0,
): boolean {
  if (now.date !== bookingDate) return false; // 🔴 untouched — ruling 1: same day only
  const start = timeToMinutes(hhmm(startTime)) - earlyMinutes;
  const end = lateWindowEnd(endTime, lateMinutes);
  return now.minutes >= start && now.minutes <= end;
}

export function checkinWindowMessage(
  bookingDate: string,
  startTime: string,
  endTime: string,
  earlyMinutes: number = CHECKIN_EARLY_MINUTES,
  lateMinutes = 0,
): string {
  const open = timeToMinutes(hhmm(startTime)) - earlyMinutes;
  const oh = String(Math.floor(open / 60)).padStart(2, "0");
  const om = String(open % 60).padStart(2, "0");
  // TASK-474 — the message quotes the window's REAL end (class end + late); with 0 it is the class end, as before.
  return `เช็คอินได้ ${bookingDate} เวลา ${oh}:${om}–${hhmmOf(lateWindowEnd(endTime, lateMinutes))} น.`;
}
