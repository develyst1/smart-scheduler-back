// End-of-day auto-mark rule (UC-012). A CONFIRMED class that has ended with no check-in and no leave is marked
// ATTENDED and its course/voucher session consumed. Pure helpers — no DB. Only CONFIRMED qualifies, which makes
// the sweep idempotent: a second run finds nothing left to mark.
//
// REQ-070 / TASK-180: this rule is UNCHANGED — which sessions the job acts on is exactly what it was. Only the
// status it writes changed (NO_SHOW → ATTENDED), so `isNoShow` is renamed `isDueForAutoAttend`: the predicate
// never decided a child was absent, it only found the sessions nobody had marked.
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

/** True when the day-end job should mark this booking ATTENDED and consume its session. */
export function isDueForAutoAttend(b: AutoCutBooking, now: BangkokNow = bangkokNow()): boolean {
  return b.status === "CONFIRMED" && minutesUntilClassEnd(b.date, b.endTime, now) <= 0;
}
