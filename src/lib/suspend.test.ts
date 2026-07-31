import { describe, expect, test } from "bun:test";
import { bookingBlockedBySuspension, isSuspended } from "./suspend";

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

describe("bookingBlockedBySuspension — the server-side booking gate", () => {
  test("🚫 a suspended household is refused a NEW booking", () => {
    expect(bookingBlockedBySuspension({ suspendedAt: new Date() })).toBe(true);
  });

  test("an active household is unchanged", () => {
    expect(bookingBlockedBySuspension({ suspendedAt: null })).toBe(false);
    expect(bookingBlockedBySuspension({})).toBe(false);
  });

  test("🔑 a walk-in / First-Trial student with NO parent is never blocked", () => {
    // `students.parent_id` is nullable by design — there is no household to suspend.
    expect(bookingBlockedBySuspension(null)).toBe(false);
    expect(bookingBlockedBySuspension(undefined)).toBe(false);
  });
});
