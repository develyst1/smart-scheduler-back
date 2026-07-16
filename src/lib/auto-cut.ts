// Auto-cut end-of-day rule (UC-012). A CONFIRMED class that ends with no check-in
// (never ATTENDED) and no leave (never SICK_LEAVE) is a no-show → its course/voucher
// quota is cut at end of day. Pure helpers — no DB. Only CONFIRMED qualifies, which
// makes the sweep idempotent: a second run finds nothing left to cut.

import { bangkokNow, timeToMinutes, type BangkokNow } from "./bangkok-time";

const dayNumber = (isoDate: string): number => {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** Minutes from `now` until the class ENDS (<= 0 once it has ended). */
export function minutesUntilClassEnd(
  bookingDate: string,
  endTime: string,
  now: BangkokNow = bangkokNow(),
): number {
  const dayDiff = dayNumber(bookingDate) - dayNumber(now.date);
  return dayDiff * 1440 + (timeToMinutes(endTime) - now.minutes);
}

export interface AutoCutBooking {
  status: string;
  date: string;
  endTime: string;
}

/** True when this booking is a no-show whose quota should be cut at end of day. */
export function isNoShow(b: AutoCutBooking, now: BangkokNow = bangkokNow()): boolean {
  return b.status === "CONFIRMED" && minutesUntilClassEnd(b.date, b.endTime, now) <= 0;
}
