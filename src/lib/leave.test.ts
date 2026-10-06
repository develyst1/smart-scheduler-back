import { describe, expect, test } from "bun:test";
import * as LEAVE from "./leave";
import { leaveQuota, toCourseSummary } from "./leave";
import { courseExpiry } from "./recurring"; // 🔻 TASK-650 — the expiry the label now reads, built by the real rule

const base = { id: "x", startDate: "2025-10-01", usedSessions: 0, adminUnlocked: false, expiryDate: "2026-01-01" };

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
  });

  test("🔻 TASK-656 — quota exhausted → NOT locked: leaves are unlimited, the counter is a plain count and `leaveLocked` is always false", () => {
    const s = toCourseSummary({ ...base, size: 4, leaveUsed: 1 });
    expect(s.leaveRemaining).toBe(0); // the old allowance still reads zero (the number is kept, it gates nothing)
    expect(s.leaveLocked).toBe(false);
    expect(toCourseSummary({ ...base, size: 4, leaveUsed: 99 }).leaveLocked).toBe(false);
  });

  test("admin unlock overrides the lock", () => {
    const c = { ...base, size: 4, leaveUsed: 1, adminUnlocked: true };
    expect(toCourseSummary(c).leaveLocked).toBe(false);
    expect(LEAVE).not.toHaveProperty("canTakeLeave"); // 🔻 TASK-656 follow-up — deleted: a dead function that reads like a gate
  });

  test("maxWeek ceilings", () => {
    // 🔻 TASK-650 — `maxWeek` is now read from the course's STORED EXPIRY (it used to be re-derived from `size + quota`).
    // ⚠️ So this test's shared `base` fixture matters where it never did: it carried an arbitrary `expiryDate` 13 weeks after
    // its start, which now IS the answer. 🔑 The fixture was not wrong before — it was meaningless, and a meaningless value in a
    // fixture becomes a wrong one the moment something starts reading it.
    // ⇒ each case now carries the expiry its own size implies, through the real rule.
    const at = (size: number) => ({ ...base, size, leaveUsed: 0, expiryDate: courseExpiry(base.startDate, size) });
    expect(toCourseSummary(at(4)).maxWeek).toBe(5);
    expect(toCourseSummary(at(10)).maxWeek).toBe(13);
    // …and the claim that replaces the old one: a STRETCHED expiry is reported as the week it really reaches
    expect(toCourseSummary({ ...at(4), expiryDate: courseExpiry(base.startDate, 4, 4) }).maxWeek).toBe(8);
  });
});
