import { describe, expect, test } from "bun:test";
import { blockedBySuspension, isSuspended } from "./suspend";

describe("isSuspended — null means active (REQ-019 / TASK-048)", () => {
  test("no timestamp → active", () => {
    expect(isSuspended(null)).toBe(false);
    expect(isSuspended(undefined)).toBe(false);
  });
  test("any timestamp → suspended", () => {
    expect(isSuspended(new Date())).toBe(true);
    expect(isSuspended("2026-08-01T00:00:00Z")).toBe(true);
  });
});

// ONE predicate for both gates — booking (TASK-048) and buying (TASK-058). If these ever need to diverge,
// that's a product decision, not something a second copy of the rule should decide by accident.
describe("blockedBySuspension — the gate for BOOKING and BUYING", () => {
  test("🚫 a suspended household is refused a NEW booking", () => {
    expect(blockedBySuspension({ suspendedAt: new Date() })).toBe(true);
  });

  test("🚫 …and refused a PURCHASE (course / voucher) — same rule, same answer", () => {
    // `createCoursePackage` / `createVoucher` call it via `assertHouseholdNotSuspended`.
    expect(blockedBySuspension({ suspendedAt: new Date("2026-08-01T00:00:00Z") })).toBe(true);
  });

  test("an active household is unchanged (books AND buys)", () => {
    expect(blockedBySuspension({ suspendedAt: null })).toBe(false);
    expect(blockedBySuspension({})).toBe(false);
  });

  test("🔑 a walk-in / First-Trial student with NO parent is never blocked — booking or buying", () => {
    // `students.parent_id` is nullable by design — there is no household to suspend.
    expect(blockedBySuspension(null)).toBe(false);
    expect(blockedBySuspension(undefined)).toBe(false);
  });
});
