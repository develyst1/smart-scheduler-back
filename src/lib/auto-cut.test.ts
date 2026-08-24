import { describe, expect, test } from "bun:test";
import { isDueForAutoAttend, minutesUntilClassEnd } from "./auto-cut";

const now = { date: "2026-07-16", time: "18:05", minutes: 18 * 60 + 5 }; // 18:05

describe("auto-cut end-of-day rule (UC-012)", () => {
  test("minutesUntilClassEnd — negative once the class has ended", () => {
    expect(minutesUntilClassEnd("2026-07-16", "18:00", now)).toBe(-5); // ended 5 min ago
    expect(minutesUntilClassEnd("2026-07-16", "19:00", now)).toBe(55); // still to come
    expect(minutesUntilClassEnd("2026-07-15", "18:00", now)).toBe(-1445); // yesterday
  });

  test("CONFIRMED class that has ended today → due for auto-attend", () => {
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-07-16", endTime: "18:00" }, now)).toBe(true);
  });

  test("CONFIRMED class still upcoming today → NOT due", () => {
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-07-16", endTime: "19:00" }, now)).toBe(false);
  });

  test("class ending exactly now (endTime == now) → due (window is inclusive)", () => {
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-07-16", endTime: "18:05" }, now)).toBe(true);
  });

  test("already ATTENDED / SICK_LEAVE / NO_SHOW → never re-marked (idempotent)", () => {
    for (const status of ["ATTENDED", "SICK_LEAVE", "NO_SHOW", "CANCELLED", "PENDING"]) {
      expect(isDueForAutoAttend({ status, date: "2026-07-16", endTime: "10:00" }, now)).toBe(false);
    }
  });

  test("CONFIRMED class on a past date → cut regardless of time", () => {
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-07-15", endTime: "09:00" }, now)).toBe(true);
  });

  test("CONFIRMED class on a future date → not cut", () => {
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-07-17", endTime: "09:00" }, now)).toBe(false);
  });
});
