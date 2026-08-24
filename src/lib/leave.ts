// Leave-quota / extension rules — the AUTHORITATIVE copy (ported from the
// frontend's src/lib/scheduler/leave.ts). The FE may mirror these for instant UX,
// but this server result is the source of truth.

import { courseStatus, type CourseStatus } from "./course-status";
import { bangkokNow } from "./bangkok-time";

export type PackageSize = 4 | 6 | 10;

/** Leave quota bound to course size: 4→1, 6→2, 10→3. */
export const LEAVE_QUOTA_BY_SIZE: Record<number, number> = { 4: 1, 6: 2, 10: 3 };

/** Max week the schedule may extend to: 4→5, 10→13. (6→8 is an ASSUMPTION — confirm.) */
export const MAX_WEEK_BY_SIZE: Record<number, number> = { 4: 5, 6: 8, 10: 13 };

export interface CourseLike {
  id: string;
  size: number;
  usedSessions: number;
  leaveUsed: number;
  adminUnlocked: boolean;
  expiryDate: string;
  /** TASK-181 (REQ-036) — ended early (null for a live course). Read via `CourseLike` so every screen that
   *  renders a course summary sees it, rather than only the one that ended it. */
  endedAt?: Date | string | null;
  endReason?: string | null;
}

export interface CourseSummary {
  id: string;
  size: PackageSize;
  usedSessions: number;
  leaveUsed: number;
  leaveQuota: number;
  leaveRemaining: number;
  maxWeek: number;
  leaveLocked: boolean;
  adminUnlocked: boolean;
  expiryDate: string;
  endedAt: string | null;
  endReason: string | null;
  /**
   * SPEC-064 / TASK-188 (REQ-036 B3) — the lifecycle status the badge renders AND the filter filters on.
   * Computed HERE, in the one builder every course response flows through, so the two cannot diverge — which
   * is what let a cancelled course wear a green `ปกติ` badge in the first place.
   */
  status: CourseStatus;
}

export const leaveQuota = (size: number) => LEAVE_QUOTA_BY_SIZE[size] ?? 0;

export function toCourseSummary(c: CourseLike, today?: string): CourseSummary {
  const quota = leaveQuota(c.size);
  const maxWeek = MAX_WEEK_BY_SIZE[c.size] ?? 0;
  const leaveRemaining = Math.max(0, quota - c.leaveUsed);
  const leaveLocked = c.leaveUsed >= quota && !c.adminUnlocked;
  return {
    id: c.id,
    size: c.size as PackageSize,
    usedSessions: c.usedSessions,
    leaveUsed: c.leaveUsed,
    leaveQuota: quota,
    leaveRemaining,
    maxWeek,
    leaveLocked,
    adminUnlocked: c.adminUnlocked,
    // SPEC-064 / TASK-181 (REQ-036) — an ended course must LOOK ended everywhere it appears, or staff will
    // keep booking into it from a screen that shows nothing wrong. `size` deliberately still reads what the
    // family bought; this is the flag that says the plan is finished.
    endedAt: c.endedAt ? (typeof c.endedAt === "string" ? c.endedAt : c.endedAt.toISOString()) : null,
    endReason: c.endReason ?? null,
    // The clock is resolved once, here, in Bangkok — never inside the pure rule, which takes `today` so it
    // stays testable and cannot pick up the server's timezone by accident.
    status: courseStatus(c, today ?? bangkokNow().date),
    expiryDate: c.expiryDate,
  };
}

/** true = may still take leave / extend the schedule. */
export function canTakeLeave(c: CourseLike): boolean {
  return toCourseSummary(c).leaveRemaining > 0 || c.adminUnlocked;
}
