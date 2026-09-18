// End-of-day auto-mark rule (UC-012). A CONFIRMED class that has STARTED with no check-in and no leave is marked
// ATTENDED and its course/voucher session consumed. Pure helpers — no DB. Only CONFIRMED qualifies, which makes
// the sweep idempotent: a second run finds nothing left to mark.
//
// REQ-070 / TASK-180: only the status it writes changed then (NO_SHOW → ATTENDED), so `isNoShow` became
// `isDueForAutoAttend`: the predicate never decided a child was absent, it only found the sessions nobody had marked.
// 🔴 TASK-396 (the OWNER'S RULING, 2026-09-18): the gate is the START time, not the end — the team leaves at 17:30
// and a 17:00–18:00 class must be cut at that run; a conscious override of REQ-070's "not before it ends". This
// file is the PURE MIRROR of the SQL in `jobs.service.ts` (no production caller) and must flip WITH it, or the
// value tests would pin a rule the job no longer runs.
import { bangkokNow, timeToMinutes, type BangkokNow } from "./bangkok-time";

const dayNumber = (isoDate: string): number => {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** Minutes from `now` until the class STARTS (<= 0 once it has started). TASK-396. */
export function minutesUntilClassStart(
  bookingDate: string,
  startTime: string,
  now: BangkokNow = bangkokNow(),
): number {
  const dayDiff = dayNumber(bookingDate) - dayNumber(now.date);
  return dayDiff * 1440 + (timeToMinutes(startTime) - now.minutes);
}

export interface AutoCutBooking {
  status: string;
  date: string;
  startTime: string;
}

/** True when the day-end job should mark this booking ATTENDED and consume its session — a CONFIRMED class that has STARTED. */
export function isDueForAutoAttend(b: AutoCutBooking, now: BangkokNow = bangkokNow()): boolean {
  return b.status === "CONFIRMED" && minutesUntilClassStart(b.date, b.startTime, now) <= 0;
}
