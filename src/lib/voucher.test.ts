import { describe, expect, test } from "bun:test";
import { isVoucherHours, voucherExpiry, voucherRemaining, voucherUsable } from "./voucher";

describe("voucher rules (B.5)", () => {
  test("validity months by size: 5→3, 10→6, 15→9 from first booking", () => {
    expect(voucherExpiry(5, "2026-07-01")).toBe("2026-10-01");
    expect(voucherExpiry(10, "2026-07-01")).toBe("2027-01-01");
    expect(voucherExpiry(15, "2026-07-01")).toBe("2027-04-01");
  });

  test("remaining hours = total - used (never negative)", () => {
    expect(voucherRemaining({ totalHours: 10, usedHours: 3, expiryDate: "2026-12-31" })).toBe(7);
    expect(voucherRemaining({ totalHours: 5, usedHours: 9, expiryDate: "2026-12-31" })).toBe(0);
  });

  test("usable when hours remain and not past expiry", () => {
    const v = { totalHours: 10, usedHours: 2, expiryDate: "2026-12-31" };
    expect(voucherUsable(v, "2026-08-01").ok).toBe(true);
  });

  test("blocked when no hours left", () => {
    const r = voucherUsable({ totalHours: 5, usedHours: 5, expiryDate: "2026-12-31" }, "2026-08-01");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("หมด");
  });

  test("blocked when booking date is past expiry", () => {
    const r = voucherUsable({ totalHours: 10, usedHours: 1, expiryDate: "2026-07-31" }, "2026-08-01");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("หมดอายุ");
  });

  test("isVoucherHours guards 5/10/15", () => {
    expect(isVoucherHours(10)).toBe(true);
    expect(isVoucherHours(7)).toBe(false);
  });
});
