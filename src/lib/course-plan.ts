// SPEC-028 / TASK-092 — the course-plan reconcile ENGINE (pure). A course owes `size` teachable sessions;
// leave and insert are moves *within* that number, never changes to it. The plan is a read-projection over
// the course's bookings — this decides WHICH sessions move and HOW, and never touches the DB (the applier
// `reconcileCoursePlan` does). Direct analog of TASK-091's `planHoldMoves`: a target + moves toward it.

/** LIVE = still owed/scheduled; DELIVERED = the session happened (attended, or forfeited as NO_SHOW). */
export const COURSE_LIVE = new Set(["PENDING", "CONFIRMED", "EXTENDED"]);
export const COURSE_DELIVERED = new Set(["ATTENDED", "NO_SHOW"]);
// SICK_LEAVE earns a replacement (neither live nor delivered); CANCELLED is out of the plan.

import { courseExpiry } from "./recurring";

export interface PlanSession {
  id: string;
  status: string;
  date: string; // "YYYY-MM-DD" — ISO, so string compare = date order
  extendedFromId: string | null;
}

export interface CoursePlan {
  /** Sessions to add (short course). One per owed slot; carries the absence id that opened the gap. */
  append: Array<{ extendedFromId: string | null }>;
  /** Sessions to cancel (long course) — newest appended `EXTENDED` first; never delivered/hand-placed. */
  cancelIds: string[];
}

/** Count toward the target: LIVE + DELIVERED. The invariant is `this == size` after any reconcile. */
export function courseCurrent(sessions: PlanSession[]): number {
  return sessions.filter((s) => COURSE_LIVE.has(s.status) || COURSE_DELIVERED.has(s.status)).length;
}

// ── Guards for the applier (TASK-093) — pure, so each rule is pinned independently of the DB write ──

/** A delivered session (attended, or forfeited as NO_SHOW) is immutable — can't be edited/moved/cancelled. */
export const isDelivered = (status: string): boolean => COURSE_DELIVERED.has(status);

/**
 * An insert is only valid when the course has an outstanding owed session to satisfy: it's currently **short**
 * (a leave opened a gap the insert fills directly), OR there is an appended `EXTENDED` session the reconcile
 * can cancel to net-zero. Otherwise the insert would grow the course to `size + 1` — refuse instead
 * ("คอร์สนี้ครบจำนวนคาบแล้ว — ไม่มีคาบค้างให้เลื่อน", SPEC-028 §2).
 */
export function canInsert(sessions: PlanSession[], size: number): boolean {
  return courseCurrent(sessions) < size || sessions.some((s) => s.status === "EXTENDED");
}

/**
 * Does an appended/extended date exceed the course's HARD ceiling (`startDate + MAX_WEEK_BY_SIZE weeks`, =
 * `courseExpiry`)? The append refuses past it (SPEC-028 §5 #2 — today nothing enforces `MAX_WEEK`, so a leave
 * could extend a course indefinitely). Week-8 for a size-6 is owner-confirmed and load-bearing.
 */
export function exceedsExtensionCeiling(date: string, startDate: string, size: number): boolean {
  return date > courseExpiry(startDate, size);
}

/**
 * The moves to bring a course back to `size` teachable sessions.
 * - short  (`current < size`): append `size − current` sessions, each linked to an unmatched SICK_LEAVE.
 * - long   (`current > size`): cancel the newest-dated `EXTENDED` (appended) sessions — never an
 *   attended/delivered or a hand-placed (non-`EXTENDED`) session.
 * - at target: no moves (idempotent — a date/teacher-only edit yields zero moves).
 */
export function planCourseMoves(sessions: PlanSession[], size: number): CoursePlan {
  const current = courseCurrent(sessions);

  if (current === size) return { append: [], cancelIds: [] };

  if (current < size) {
    const need = size - current;
    // A leave is "matched" once some session was appended for it (extendedFromId points back to it).
    const matched = new Set(
      sessions.map((s) => s.extendedFromId).filter((x): x is string => x !== null),
    );
    const unmatchedLeaves = sessions
      .filter((s) => s.status === "SICK_LEAVE" && !matched.has(s.id))
      .sort((a, b) => a.date.localeCompare(b.date)); // oldest gap first
    const append = Array.from({ length: need }, (_, i) => ({
      extendedFromId: unmatchedLeaves[i]?.id ?? null,
    }));
    return { append, cancelIds: [] };
  }

  // long: remove the trailing appended session(s) — newest-dated LIVE EXTENDED first.
  const over = current - size;
  const cancelIds = sessions
    .filter((s) => s.status === "EXTENDED")
    .sort((a, b) => b.date.localeCompare(a.date)) // newest first
    .slice(0, over)
    .map((s) => s.id);
  return { append: [], cancelIds };
}
