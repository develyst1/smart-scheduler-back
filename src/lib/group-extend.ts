// TASK-456 (REQ-105 §3) — "which dates is this group series MISSING?", the pure half.
//
// 🔑 The rolling extender exists because a group slot has NO end date: it runs every week until an admin closes it
// (TASK-453's `group_closed_at`). Rows are real bookings, so somebody has to create them — and "somebody" being a
// human who remembers is how a class quietly stops existing three weeks out.
//
// 🔑 IDEMPOTENT BY STATE, never by a stamp: the answer is derived from the rows that exist, so a second run the same
// day returns nothing to do. A "last extended on" marker would be a second fact that can disagree with the rows.
import { addDays } from "./time";

export const GROUP_EXTENDER_JOB = "group-series-extender";

/**
 * The weekly dates this series still needs: every 7-day step AFTER its last row, up to `horizon`, that does not
 * already exist and is not in the past.
 *
 * ⚠️ `from` (normally today) is what stops an ABANDONED series from being back-filled: a series whose last row was in
 * March must not suddenly gain thirty past Tuesdays. The steps keep the series' own weekday — they are counted from
 * the last row, not from today — so a Tuesday class stays a Tuesday class.
 */
export function weeklyDatesToCreate(o: { existing: readonly string[]; from: string; horizon: string }): string[] {
  // 🔴 TASK-465 — the loop below compares dates as STRINGS, which is only a bound when both sides ARE dates. With a
  // horizon of `"NaN-NaN-NaN"`, `"2026-11-13" <= "NaN-NaN-NaN"` is TRUE (digits sort before "N") and stays true for
  // ever — measured: 360,756 steps in 300 ms, past the year 8940, synchronous, the array growing without end. So the
  // inputs are checked here, where the loop is, not only by the caller.
  for (const [name, v] of [["from", o.from], ["horizon", o.horizon]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`weeklyDatesToCreate: ${name} is not a date ("${v}")`);
  }
  const last = [...o.existing].sort().pop();
  if (!last) return []; // a series with no row at all is not a series — nothing to extend, nothing to guess
  const out: string[] = [];
  for (let d = addDays(last, 7); d <= o.horizon; d = addDays(d, 7)) {
    // 🚫 No "skip a date that already exists" branch, and that is deliberate: the anchor is the MAXIMUM existing
    // date, so no later step can already be there. A guard for an impossible case reads as if the case happens —
    // and a break-and-watch run proved it: removing such a check changes NOTHING, which is the definition of dead
    // code. The property (never a duplicate) is pinned in the suite instead of guarded here.
    if (d < o.from) continue;
    out.push(d);
  }
  return out;
}
