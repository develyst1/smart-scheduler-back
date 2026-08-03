import { describe, expect, test } from "bun:test";
import { isOrphanedSession } from "./attention";
import { weekdayOf } from "./recurring";

const today = "2026-08-10";
const future = "2026-08-15";
const past = "2026-08-05";
const allDays = [0, 1, 2, 3, 4, 5, 6];
const futureWd = weekdayOf(future); // the weekday the session actually falls on

describe("isOrphanedSession — orphaned course session (TASK-096)", () => {
  test("archived teacher on a future LIVE session → orphaned", () => {
    const t = { archived: true, workDays: allDays };
    expect(isOrphanedSession({ status: "CONFIRMED", date: future }, t, today)).toBe(true);
  });

  test("teacher no longer works that weekday → orphaned", () => {
    const t = { archived: false, workDays: allDays.filter((d) => d !== futureWd) };
    expect(isOrphanedSession({ status: "EXTENDED", date: future }, t, today)).toBe(true);
  });

  test("available, non-archived teacher who works that day → not orphaned", () => {
    const t = { archived: false, workDays: [futureWd] };
    expect(isOrphanedSession({ status: "PENDING", date: future }, t, today)).toBe(false);
  });

  test("a PAST session is never orphaned (can't be disrupted anymore)", () => {
    const t = { archived: true, workDays: allDays };
    expect(isOrphanedSession({ status: "CONFIRMED", date: past }, t, today)).toBe(false);
  });

  test("today counts as future (date >= today)", () => {
    const t = { archived: true, workDays: allDays };
    expect(isOrphanedSession({ status: "CONFIRMED", date: today }, t, today)).toBe(true);
  });

  test("delivered / cancelled sessions are settled → never orphaned", () => {
    const t = { archived: true, workDays: allDays };
    for (const status of ["ATTENDED", "NO_SHOW", "CANCELLED", "SICK_LEAVE"]) {
      expect(isOrphanedSession({ status, date: future }, t, today)).toBe(false);
    }
  });

  test("no teacher record → not counted (nothing to name)", () => {
    expect(isOrphanedSession({ status: "CONFIRMED", date: future }, null, today)).toBe(false);
  });
});
