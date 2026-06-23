import { describe, expect, test } from "bun:test";
import { canTakeLeave, leaveQuota, toCourseSummary } from "./leave";

const base = { id: "x", usedSessions: 0, adminUnlocked: false, expiryDate: "2026-01-01" };

describe("leave quota rules", () => {
  test("quota by size: 4→1, 6→2, 10→3", () => {
    expect(leaveQuota(4)).toBe(1);
    expect(leaveQuota(6)).toBe(2);
    expect(leaveQuota(10)).toBe(3);
  });

  test("under quota → remaining > 0, not locked", () => {
    const s = toCourseSummary({ ...base, size: 10, leaveUsed: 1 });
    expect(s.leaveRemaining).toBe(2);
    expect(s.leaveLocked).toBe(false);
    expect(canTakeLeave({ ...base, size: 10, leaveUsed: 1 })).toBe(true);
  });

  test("quota exhausted → locked, cannot take leave", () => {
    const s = toCourseSummary({ ...base, size: 4, leaveUsed: 1 });
    expect(s.leaveRemaining).toBe(0);
    expect(s.leaveLocked).toBe(true);
    expect(canTakeLeave({ ...base, size: 4, leaveUsed: 1 })).toBe(false);
  });

  test("admin unlock overrides the lock", () => {
    const c = { ...base, size: 4, leaveUsed: 1, adminUnlocked: true };
    expect(toCourseSummary(c).leaveLocked).toBe(false);
    expect(canTakeLeave(c)).toBe(true);
  });

  test("maxWeek ceilings", () => {
    expect(toCourseSummary({ ...base, size: 4, leaveUsed: 0 }).maxWeek).toBe(5);
    expect(toCourseSummary({ ...base, size: 10, leaveUsed: 0 }).maxWeek).toBe(13);
  });
});
