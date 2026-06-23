// Leave-quota / extension rules — the AUTHORITATIVE copy (ported from the
// frontend's src/lib/scheduler/leave.ts). The FE may mirror these for instant UX,
// but this server result is the source of truth.

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
}

export const leaveQuota = (size: number) => LEAVE_QUOTA_BY_SIZE[size] ?? 0;

export function toCourseSummary(c: CourseLike): CourseSummary {
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
    expiryDate: c.expiryDate,
  };
}

/** true = may still take leave / extend the schedule. */
export function canTakeLeave(c: CourseLike): boolean {
  return toCourseSummary(c).leaveRemaining > 0 || c.adminUnlocked;
}
