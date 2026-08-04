import { describe, expect, test } from "bun:test";
import { holdsSlot } from "./booking-slot";

describe("holdsSlot — matches the partial unique index (TASK-095 rework)", () => {
  test("a leave/cancelled/reschedule occupant does NOT hold the slot (overbookable)", () => {
    for (const s of ["CANCELLED", "PENDING_RESCHEDULE", "SICK_LEAVE"]) {
      expect(holdsSlot(s)).toBe(false);
    }
  });
  test("an active occupant holds the slot (clash)", () => {
    for (const s of ["PENDING", "CONFIRMED", "EXTENDED", "ATTENDED", "NO_SHOW"]) {
      expect(holdsSlot(s)).toBe(true);
    }
  });
});
