// TASK-144 (SPEC-043 / REQ-050 Gap-C) — the rule that decides whether a cancel gives a family back what the
// check-in took. Money-adjacent, so the precondition and the floor are both pinned here.
import { describe, expect, test } from "bun:test";
import { returnsConsumedUnit } from "./checkin-correction";

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

// 🔻 TASK-496 — `afterReturn`'s tests moved with the rule: the unit comes back as `GREATEST(x - 1, 0)` in the WRITE (one unit,
// never below zero, and a NULL-free NOT NULL column), pinned by value in `counter-sql-req108.test.ts`.
