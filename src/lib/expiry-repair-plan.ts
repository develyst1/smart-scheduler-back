// FIX-007 / TASK-195 — recompute every course's `expiryDate` from the rule that should have set it.
//
// 🔴 **The dry-run list is the deliverable here, not the UPDATE.** Since the `EXPIRED` status shipped, a
// course's expiry decides whether a real family reads as finished on the owner's screen — so a repair that
// silently expires live families is the worst possible way to be technically right. This computes the change
// set and, separately, **who becomes EXPIRED the moment it commits**, so the owner reads that list of names
// before a single row is written.
//
// Pure — no DB, no clock. `today` is passed in (Bangkok, resolved by the caller).

import { courseExpiry, importedCourseExpiry } from "./recurring";

export interface RepairCourse {
  id: string;
  nickname: string | null;
  source: string;
  size: number;
  priorSessions: number;
  startDate: string;
  expiryDate: string;
  /** The latest date among the course's still-live sessions — for AC-4. `null` when nothing is live. */
  lastLiveSessionDate: string | null;
}

export interface RepairChange {
  id: string;
  nickname: string | null;
  source: string;
  from: string;
  to: string;
  /** True when this course reads ACTIVE today and would read EXPIRED once the change commits. */
  newlyExpired: boolean;
  /** AC-4: a live session sits after the corrected expiry. Surfaced for a human — never moved, never hidden. */
  liveSessionPastExpiry: string | null;
}

/** The expiry a course SHOULD have: imported courses reconstruct their real start; native ones count from theirs. */
export function correctExpiry(c: RepairCourse): string {
  return c.source === "IMPORT"
    ? importedCourseExpiry(c.startDate, c.size, c.priorSessions)
    : courseExpiry(c.startDate, c.size);
}

/**
 * 🔴 TASK-200 — **imported courses are excluded from the repair entirely.** The owner's ruling is *"ข้ามการแก้
 * วันexpire คอร์สนำเข้าไปก่อน"*: an imported expiry is a date a **human typed**, and it may encode an agreement
 * with that family that no rule of ours can see. Recomputing it would silently overwrite the agreement with
 * arithmetic.
 *
 * The exclusion is here, **before the map**, and not inside `correctExpiry` — a course that never enters the
 * list cannot appear in the changes, the counts, or the flip list by any later edit. Filtering afterwards, or
 * relying on the branch inside `correctExpiry`, is what made this wrong the first time: the branch existed, so
 * the code *looked* source-aware while still rewriting every import.
 *
 * `importedCourseExpiry` stays in the codebase on purpose — it is correct, and it is what **future** imports
 * should compute once the import form is fixed. What is banned is retro-rewriting rows a human already filled.
 */
export function planExpiryRepair(courses: RepairCourse[], today: string): RepairChange[] {
  return courses
    .filter((c) => c.source !== "IMPORT")
    .map((c) => {
      const to = correctExpiry(c);
      return {
        id: c.id,
        nickname: c.nickname,
        source: c.source,
        from: c.expiryDate,
        to,
        // "Newly expired" means the STATUS flips, not merely that the date moved earlier — a course already
        // past its old expiry is not news, and burying the real cases in it would defeat the point of the list.
        newlyExpired: c.expiryDate >= today && to < today,
        // AC-4: flag, never fix. A session sitting past the corrected expiry was almost certainly moved there
        // by hand for a real reason, and this tool has no business deciding what that reason was.
        liveSessionPastExpiry:
          c.lastLiveSessionDate && c.lastLiveSessionDate > to ? c.lastLiveSessionDate : null,
      };
    })
    .filter((c) => c.from !== c.to)
    .sort((a, b) => Number(b.newlyExpired) - Number(a.newlyExpired) || a.to.localeCompare(b.to));
}

/** Counts for the console — the owner sees the scale before any name (names go to the gitignored report). */
export const repairSummary = (changes: RepairChange[]) => ({
  changed: changes.length,
  newlyExpired: changes.filter((c) => c.newlyExpired).length,
  liveSessionPastExpiry: changes.filter((c) => c.liveSessionPastExpiry).length,
  earlier: changes.filter((c) => c.to < c.from).length,
  later: changes.filter((c) => c.to > c.from).length,
});
