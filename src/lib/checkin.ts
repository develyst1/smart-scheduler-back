// Check-in token + time-window rules (C.1). Pure helpers — no DB.

import { bangkokNow, timeToMinutes } from "./bangkok-time";
import { hhmm } from "./time";

/** Minutes before class start that check-in opens (e.g. 30 min early). */
export const CHECKIN_EARLY_MINUTES = 30;

export function generateCheckinToken(): string {
  // 24 hex chars — enough entropy for a one-day token
  return crypto.randomUUID().replace(/-/g, "");
}

/** True when Bangkok wall-clock is inside [start−early, end] on the booking date. `earlyMinutes` defaults to the
 *  coded constant; the check-in service resolves the `checkin_early_minutes` setting and passes it (SPEC-029). */
export function isWithinCheckinWindow(
  bookingDate: string,
  startTime: string,
  endTime: string,
  now = bangkokNow(),
  earlyMinutes: number = CHECKIN_EARLY_MINUTES,
): boolean {
  if (now.date !== bookingDate) return false;
  const start = timeToMinutes(hhmm(startTime)) - earlyMinutes;
  const end = timeToMinutes(hhmm(endTime));
  return now.minutes >= start && now.minutes <= end;
}

export function checkinWindowMessage(
  bookingDate: string,
  startTime: string,
  endTime: string,
  earlyMinutes: number = CHECKIN_EARLY_MINUTES,
): string {
  const open = timeToMinutes(hhmm(startTime)) - earlyMinutes;
  const oh = String(Math.floor(open / 60)).padStart(2, "0");
  const om = String(open % 60).padStart(2, "0");
  return `เช็คอินได้ ${bookingDate} เวลา ${oh}:${om}–${hhmm(endTime)} น.`;
}
