import { describe, expect, test } from "bun:test";
import {
  drawCeilingHour,
  heldTarget,
  isFreelanceConsuming,
  overLimit,
  reconcileDelta,
  reconcileRemaining,
  shouldCloseCeiling,
} from "./freelance-budget";

describe("drawCeilingHour — 1h ceiling draw (TASK-024)", () => {
  test("draws one hour when within the ceiling", () => {
    expect(drawCeilingHour(140, false)).toEqual({ blocked: false, remainingAfter: 139 });
  });
  test("last hour draws to zero", () => {
    expect(drawCeilingHour(1, false)).toEqual({ blocked: false, remainingAfter: 0 });
  });
  test("no hours left, no override → blocked (remaining untouched)", () => {
    expect(drawCeilingHour(0, false)).toEqual({ blocked: true, remainingAfter: 0 });
  });
  test("override allows going negative", () => {
    expect(drawCeilingHour(0, true)).toEqual({ blocked: false, remainingAfter: -1 });
  });
});

describe("overLimit", () => {
  test("remaining ≤ 0 → over limit (FE hides the teacher)", () => {
    expect(overLimit(0)).toBe(true);
    expect(overLimit(-1)).toBe(true);
    expect(overLimit(1)).toBe(false);
  });
});

describe("reconcile target — status → held (TASK-028, locked state machine)", () => {
  test("consuming statuses (freelance is paid) hold 1h", () => {
    for (const s of ["CONFIRMED", "ATTENDED", "SICK_LEAVE", "EXTENDED"]) {
      expect(isFreelanceConsuming(s)).toBe(true);
      expect(heldTarget(s)).toBe(1);
    }
  });
  test("releasing statuses (freelance NOT paid) hold 0h", () => {
    for (const s of ["NO_SHOW", "CANCELLED", "PENDING"]) {
      expect(isFreelanceConsuming(s)).toBe(false);
      expect(heldTarget(s)).toBe(0);
    }
  });
  test("SICK_LEAVE keeps the draw (the REQ-004 refund-on-leave flip)", () => {
    // held 1 → SICK_LEAVE → delta 0 → the draw is KEPT, not refunded.
    expect(reconcileDelta(1, "SICK_LEAVE")).toBe(0);
  });
});

describe("reconcileDelta — draw/refund/no-op", () => {
  test("draw one when a releasing booking becomes consuming", () => {
    expect(reconcileDelta(0, "CONFIRMED")).toBe(1);
  });
  test("refund one when a consuming booking is released", () => {
    expect(reconcileDelta(1, "CANCELLED")).toBe(-1);
    expect(reconcileDelta(1, "NO_SHOW")).toBe(-1);
  });
  test("no-op when already at target (idempotent re-run)", () => {
    expect(reconcileDelta(1, "ATTENDED")).toBe(0);
    expect(reconcileDelta(0, "CANCELLED")).toBe(0);
  });
});

describe("reconcileRemaining — clamp on refund, negative allowed on draw", () => {
  test("draw lowers remaining", () => {
    expect(reconcileRemaining(140, 140, 1)).toBe(139);
  });
  test("refund raises remaining but never above the ceiling", () => {
    expect(reconcileRemaining(139, 140, -1)).toBe(140);
    expect(reconcileRemaining(140, 140, -1)).toBe(140); // clamped — can't exceed ceiling
  });
  test("override draw may go negative (un-clamped)", () => {
    expect(reconcileRemaining(0, 140, 1)).toBe(-1);
  });
});

describe("reconcile invariant — remaining == ceiling − (# consuming bookings)", () => {
  // Simulate one booking's held/remaining evolution using only the pure reconcile fns.
  const step = (
    state: { held: number; remaining: number; ceiling: number },
    status: string,
  ) => {
    const delta = reconcileDelta(state.held, status);
    return {
      held: state.held + delta,
      remaining: reconcileRemaining(state.remaining, state.ceiling, delta),
      ceiling: state.ceiling,
    };
  };

  test("the prod repro CONFIRMED→SICK_LEAVE→ATTENDED→SICK_LEAVE never inflates remaining", () => {
    let s = { held: 0, remaining: 140, ceiling: 140 };
    for (const status of ["CONFIRMED", "SICK_LEAVE", "ATTENDED", "SICK_LEAVE"]) {
      s = step(s, status);
      expect(s.remaining).toBeLessThanOrEqual(s.ceiling); // never past ceiling (the money leak)
    }
    // one booking, still consuming → exactly one hour held.
    expect(s.held).toBe(1);
    expect(s.remaining).toBe(139);
  });

  test("cancel returns the hour and re-cancel is a no-op", () => {
    let s = { held: 1, remaining: 139, ceiling: 140 };
    s = step(s, "CANCELLED");
    expect(s).toEqual({ held: 0, remaining: 140, ceiling: 140 });
    s = step(s, "CANCELLED"); // idempotent
    expect(s).toEqual({ held: 0, remaining: 140, ceiling: 140 });
  });
});

describe("shouldCloseCeiling — only leaving FREELANCE closes the ceiling (REQ-009 / TASK-060)", () => {
  test("🔑 FREELANCE → FT/PT closes it", () => {
    expect(shouldCloseCeiling("FREELANCE", "FULL_TIME")).toBe(true);
    expect(shouldCloseCeiling("FREELANCE", "PART_TIME")).toBe(true);
  });

  test("FT↔PT never closes anything (they have no ceiling to begin with)", () => {
    expect(shouldCloseCeiling("FULL_TIME", "PART_TIME")).toBe(false);
    expect(shouldCloseCeiling("PART_TIME", "FULL_TIME")).toBe(false);
  });

  test("FREELANCE → FREELANCE is not a change — the ceiling survives a name/subject edit", () => {
    expect(shouldCloseCeiling("FREELANCE", "FREELANCE")).toBe(false);
  });

  test("🔑 an edit that doesn't touch the type leaves it alone (name-only edit)", () => {
    expect(shouldCloseCeiling("FREELANCE", undefined)).toBe(false);
    expect(shouldCloseCeiling("FULL_TIME", undefined)).toBe(false);
  });

  test("becoming freelance does not close anything", () => {
    expect(shouldCloseCeiling("FULL_TIME", "FREELANCE")).toBe(false);
  });
});
