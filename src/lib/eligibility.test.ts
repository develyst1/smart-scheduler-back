import { describe, expect, test } from "bun:test";
import { courseEligible, courseRemainingSessions, voucherEligible } from "./eligibility";
import { voucherUsable } from "./voucher";

const TODAY = "2026-08-01";

describe("courseEligible — sessions remaining AND not expired (REQ-022 / TASK-051)", () => {
  test("a course with sessions left and a future expiry is eligible", () => {
    expect(courseEligible({ size: 10, usedSessions: 3, expiryDate: "2026-10-01" }, TODAY)).toBe(true);
  });

  test("🚫 fully used → not eligible (even if not expired)", () => {
    expect(courseEligible({ size: 10, usedSessions: 10, expiryDate: "2026-10-01" }, TODAY)).toBe(false);
  });

  test("🚫 expired → not eligible (even with sessions left)", () => {
    expect(courseEligible({ size: 10, usedSessions: 2, expiryDate: "2026-07-31" }, TODAY)).toBe(false);
  });

  test("expiring exactly today is still eligible (inclusive)", () => {
    expect(courseEligible({ size: 4, usedSessions: 1, expiryDate: TODAY }, TODAY)).toBe(true);
  });

  test("remainingSessions never goes negative", () => {
    expect(courseRemainingSessions({ size: 4, usedSessions: 6, expiryDate: TODAY })).toBe(0);
    expect(courseRemainingSessions({ size: 10, usedSessions: 3, expiryDate: TODAY })).toBe(7);
  });

  test("multi-course: each entitlement is judged on its own (one row per course)", () => {
    const active = { size: 10, usedSessions: 1, expiryDate: "2026-12-01" };
    const spent = { size: 4, usedSessions: 4, expiryDate: "2026-12-01" };
    expect([active, spent].filter((c) => courseEligible(c, TODAY))).toHaveLength(1);
  });
});

describe("voucherEligible — delegates to the EXISTING voucherUsable rule (no second definition)", () => {
  const v = (usedHours: number, expiryDate: string) => ({ totalHours: 10, usedHours, expiryDate });

  test("hours left + not expired → eligible, and it agrees with voucherUsable", () => {
    const voucher = v(4, "2026-12-01");
    expect(voucherEligible(voucher, TODAY)).toBe(true);
    expect(voucherUsable(voucher, TODAY).ok).toBe(true); // same rule, not a copy
  });

  test("🚫 hours exhausted → not eligible", () => {
    expect(voucherEligible(v(10, "2026-12-01"), TODAY)).toBe(false);
  });

  test("🚫 expired → not eligible", () => {
    expect(voucherEligible(v(2, "2026-07-31"), TODAY)).toBe(false);
  });
});
