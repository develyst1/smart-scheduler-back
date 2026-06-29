import { describe, expect, test } from "bun:test";
import { buildRescheduleTarget } from "./reschedule";

describe("reschedule target (B.1)", () => {
  test("derives a one-hour endTime and preserves the move target", () => {
    const t = buildRescheduleTarget({
      reason: "MOVE_DAY",
      date: "2026-07-01",
      teacherId: "teacher-1",
      startTime: "13:00",
    });
    expect(t).toEqual({
      reason: "MOVE_DAY",
      date: "2026-07-01",
      teacherId: "teacher-1",
      startTime: "13:00",
      endTime: "14:00",
    });
  });

  test("last slot 17:00 → 18:00 (end of operating hours)", () => {
    expect(buildRescheduleTarget({ reason: "MOVE_WEEK", date: "2026-07-01", teacherId: "t", startTime: "17:00" }).endTime).toBe("18:00");
  });
});
