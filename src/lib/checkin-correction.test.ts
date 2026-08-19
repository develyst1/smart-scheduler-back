// TASK-144 (SPEC-043 / REQ-050 Gap-C) — the rule that decides whether a cancel gives a family back what the
// check-in took. Money-adjacent, so the precondition and the floor are both pinned here.
import { describe, expect, test } from "bun:test";
import { afterReturn, returnsConsumedUnit } from "./checkin-correction";

describe("returnsConsumedUnit — only a corrected ATTENDED cancel refunds", () => {
  test("ATTENDED → the unit comes back", () => {
    expect(returnsConsumedUnit("ATTENDED")).toBe(true);
  });

  test("a status that never consumed → no refund (no double-credit)", () => {
    for (const s of ["PENDING", "CONFIRMED", "SICK_LEAVE", "EXTENDED", "CANCELLED", "NO_SHOW"]) {
      expect(returnsConsumedUnit(s)).toBe(false);
    }
  });
});

describe("afterReturn — one session is one unit, and it never goes negative", () => {
  test("course usedSessions 3 → 2, voucher usedHours 5 → 4", () => {
    expect(afterReturn(3)).toBe(2);
    expect(afterReturn(5)).toBe(4);
  });

  test("already 0 stays 0 — a double-cancel can never mint entitlement", () => {
    expect(afterReturn(0)).toBe(0);
    expect(afterReturn(-2)).toBe(0); // defensive: a corrupt row still can't go further negative
  });

  test("a missing counter is treated as 0, not NaN", () => {
    expect(afterReturn(undefined as unknown as number)).toBe(0);
  });
});
