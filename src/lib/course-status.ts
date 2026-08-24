// SPEC-064 / TASK-188 (REQ-036 B3) — a course's LIFECYCLE status. One definition, computed on the server.
//
// 🔴 Why this file exists at all: there was no course-status concept in the backend. `ปกติ` was computed in the
// FE, which is exactly **why a cancelled course wore a green "ปกติ" badge** — the badge's idea of "over" and the
// data's idea of "over" were never the same object. Re-computing it for a filter would have built the same bug
// twice, in a second place, where the two could drift apart on any Tuesday. So it is computed **once**, here,
// and everything downstream renders or filters what the server said.
//
// Pure — no DB, no clock. `today` is passed in (Asia/Bangkok, resolved by the caller) so the rule is testable
// and cannot quietly depend on the server's timezone.

export const COURSE_STATUSES = ["CANCELLED", "COMPLETED", "EXPIRED", "ACTIVE"] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

export interface CourseStatusInput {
  size: number;
  usedSessions: number;
  expiryDate: string;
  /** Set when the course was ended early (TASK-181). */
  endedAt?: Date | string | null;
}

/**
 * **Precedence, first match wins — so every course is exactly one status.** That ordering is the whole design;
 * without it the four filters would double-count and AC-B6 could not hold.
 *
 * 🔴 `COMPLETED` beats `EXPIRED` deliberately (the owner's call, and it is the interesting one): a family that
 * used every session has no problem worth flagging, while **expired with sessions left is a family that paid
 * for classes they never received** — the one status that costs the customer money. A binary active/inactive
 * would have hidden exactly that case, which is why the owner overruled it.
 *
 * Lifecycle status is orthogonal to `leaveLocked` / quota state, and is deliberately not folded into it: a
 * course can be locked for leave and perfectly ACTIVE, or expired with its quota untouched.
 */
export function courseStatus(c: CourseStatusInput, today: string): CourseStatus {
  if (c.endedAt != null) return "CANCELLED";
  if (c.usedSessions >= c.size) return "COMPLETED";
  if (c.expiryDate < today) return "EXPIRED";
  return "ACTIVE";
}

/**
 * The four counts, over whatever set the caller is looking at. Every status appears even at zero — a filter
 * chip that vanishes when its count is 0 makes an empty category look like a missing feature.
 */
export function countByStatus<T extends CourseStatusInput>(
  courses: T[],
  today: string,
): Record<CourseStatus, number> {
  const counts = Object.fromEntries(COURSE_STATUSES.map((s) => [s, 0])) as Record<CourseStatus, number>;
  for (const c of courses) counts[courseStatus(c, today)]++;
  return counts;
}
