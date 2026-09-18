import { describe, expect, test } from "bun:test";
// 🔻 TASK-396 (the owner's ruling, 2026-09-18) — the gate is the START time: this file used to pin `endTime`.
import { isDueForAutoAttend, minutesUntilClassStart } from "./auto-cut";

const now = { date: "2026-07-16", time: "18:05", minutes: 18 * 60 + 5 }; // 18:05

describe("auto-cut end-of-day rule (UC-012) — a CONFIRMED class that has STARTED (TASK-396)", () => {
  test("minutesUntilClassStart — negative once the class has started", () => {
    expect(minutesUntilClassStart("2026-07-16", "18:00", now)).toBe(-5); // started 5 min ago
    expect(minutesUntilClassStart("2026-07-16", "19:00", now)).toBe(55); // still to come
    expect(minutesUntilClassStart("2026-07-15", "18:00", now)).toBe(-1445); // yesterday
  });

  test("🔴 THE RULING: a 17:00–18:00 class at a 17:30 clock ⇒ due (it has started, though not ended); a 17:45 class ⇒ not", () => {
    const half = { date: "2026-07-16", time: "17:30", minutes: 17 * 60 + 30 };
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-07-16", startTime: "17:00" }, half)).toBe(true);
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-07-16", startTime: "17:45" }, half)).toBe(false);
  });

  test("CONFIRMED class that has started today → due for auto-attend", () => {
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-07-16", startTime: "18:00" }, now)).toBe(true);
  });

  test("CONFIRMED class still upcoming today → NOT due", () => {
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-07-16", startTime: "19:00" }, now)).toBe(false);
  });

  test("class starting exactly now (startTime == now) → due (window is inclusive)", () => {
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-07-16", startTime: "18:05" }, now)).toBe(true);
  });

  test("already ATTENDED / SICK_LEAVE / NO_SHOW → never re-marked (idempotent)", () => {
    for (const status of ["ATTENDED", "SICK_LEAVE", "NO_SHOW", "CANCELLED", "PENDING"]) {
      expect(isDueForAutoAttend({ status, date: "2026-07-16", startTime: "10:00" }, now)).toBe(false);
    }
  });

  test("CONFIRMED class on a past date → cut regardless of time", () => {
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-07-15", startTime: "09:00" }, now)).toBe(true);
  });

  test("CONFIRMED class on a future date → not cut", () => {
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-07-17", startTime: "09:00" }, now)).toBe(false);
  });
});
