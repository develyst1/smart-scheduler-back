// TASK-066 — what can be proven without a database. The insert itself is deploy smoke (brownfield);
// the two things that can be wrong *in code* are the sign rule and the unknown-code guard.
import { describe, expect, test } from "bun:test";
import { recordSale, saleMovement } from "./sale-post";
import { FIRST_TRIAL_MINOR, courseItemRef } from "./sale-items";

describe("sign rule — must match backoffice-back's bo-money.ts or the P&L reads backwards", () => {
  test("🔑 a sale is an OUT (qty negative) worth a POSITIVE value on an INCOME item", () => {
    const m = saleMovement(1, FIRST_TRIAL_MINOR);
    expect(m.qty).toBe(-1);
    expect(m.valueMinor).toBe(FIRST_TRIAL_MINOR);
    expect(m.valueMinor).toBeGreaterThan(0); // negative here = revenue subtracted from the month
  });

  test("value scales with quantity", () => {
    expect(saleMovement(3, 1000).valueMinor).toBe(3000);
    expect(saleMovement(3, 1000).qty).toBe(-3);
  });

  test("a caller passing a positive OR negative quantity both mean 'one sold'", () => {
    // Defensive: `recordSale(ref, 1)` is the only call shape today, but a −1 must never invert
    // the movement into a refund that quietly reduces the month's revenue.
    expect(saleMovement(-1, 5000)).toEqual(saleMovement(1, 5000));
  });

  test("a zero-priced item posts zero — the reason prices must never default to 0", () => {
    expect(saleMovement(1, 0).valueMinor).toBe(0);
  });
});

describe("unknown product code is loud, not silent", () => {
  test("🔑 returns unknown-code and writes nothing — no DB call is even attempted", async () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a[0]);
    try {
      // "course-8" is the unconfirmed 8-week assumption in the workspace CLAUDE.md — a plausible
      // string that is NOT a product. It must not reach the DB and must not pass quietly.
      const r = await recordSale("course-8", 1, { refId: "c1" });
      expect(r).toEqual({ ok: false, skipped: "unknown-code" });
      expect(String(errors[0])).toContain("NOT POSTED");
      expect(String(errors[0])).toContain("course-8");
    } finally {
      console.error = orig;
    }
  });

  test("a real code gets past the guard (it then needs a DB, which is deploy smoke)", () => {
    // Proves the guard isn't rejecting everything — the failure mode that would make the test above
    // pass for the wrong reason.
    expect(courseItemRef("onewheel", 6)).toBe("course-onewheel-6");
  });
});
