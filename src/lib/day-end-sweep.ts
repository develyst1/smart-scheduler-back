// 🔻 TASK-749 (REQ-130) — what the day-end job POSTS. Until now it posted only the rows dated `runDate`; a trial / 1 HR / priced OTHER marked ATTENDED after that day's run (an early run with no
// 23:30 run after it, a missed run, a late check-in) was never posted, and the digest's «Sales not posted» counted it for ever. The day-end now ALSO sweeps the last `SWEEP_WINDOW_DAYS` days
// through the SAME per-booking posting path (the same price / discount resolution, `postOtherBookingSale`, and the generation-aware `rev:<id>[#n]` key — which is what makes a second run, or a
// second sweep, post nothing more).
//
// 🔁 WIDENED the same day (the owner's rule via Porter: «กวาด เช็คอิน … ควรกวาดจากเวลาเริ่ม»): the AUTO-ATTEND sweeps the same window, start-based (`sweepDates` + `startedSql`, wired in the job's own `where`), BEFORE the posting — so a late auto-attend posts in the same run.
//
// 🚫 The posting never filters by «has a SALE movement»: a booking whose attendance was undone and
// then marked AGAIN has SALE movements and still needs its NEXT generation posted — the idempotency keys decide, not a pre-filter.
import { and, eq, inArray, sql } from "drizzle-orm";
import { bookings } from "../db/schema";
import { NOT_POSTED_WINDOW_DAYS } from "./attention";
import { addDays } from "./time";

/** How many days back the day-end posts, besides `runDate` itself — the SAME window the digest's «Sales not posted» looks at, so what the digest names the sweep can reach. */
export const SWEEP_WINDOW_DAYS = NOT_POSTED_WINDOW_DAYS;
/** The booking types that post at the day-end (course / voucher revenue is recognised at sale, not here). */
export const POSTING_TYPES = ["FIRST_TRIAL", "SINGLE_SESSION", "OTHER"] as const;

/** `runDate − days … runDate`, oldest first, `YYYY-MM-DD`. */
export function sweepDates(runDate: string, days: number = SWEEP_WINDOW_DAYS): string[] {
  return Array.from({ length: days + 1 }, (_, i) => addDays(runDate, i - days));
}

/** Which attended rows the day-end posts: ATTENDED, a posting type, dated in the window (today's AND the last `SWEEP_WINDOW_DAYS` days'). */
export const postingWhere = (runDate: string) =>
  and(inArray(bookings.date, sweepDates(runDate)), eq(bookings.status, "ATTENDED"), inArray(bookings.bookingType, [...POSTING_TYPES]));

/** A row older than `runDate` is a SWEPT one: it is counted in `summary.sweptPosted`, not in `revenuePosted` (which keeps meaning «today's»). */
export const isSwept = (rowDate: string, runDate: string): boolean => rowDate < runDate;

/**
 * Has a class dated `date` STARTED at the Bangkok clock `now`? (TASK-396, the owner's start-based rule): a date before today ⇒ yes; today ⇒ only if its start time is at/behind the clock; a future date ⇒ no.
 * The pure twin of the SQL in `startedSql` — one is asserted against the other in the test.
 */
export const hasStarted = (date: string, startTime: string, now: { date: string; time: string }): boolean =>
  date < now.date || (date === now.date && startTime.slice(0, 5) <= now.time.slice(0, 5));
/** The SQL twin of `hasStarted`, for the day-end's auto-attend `where` (one clause for every day of the window). */
export const startedSql = (now: { date: string; time: string }) =>
  sql`(${bookings.date} < ${now.date} or (${bookings.date} = ${now.date} and ${bookings.startTime} <= ${now.time}::time))`;
