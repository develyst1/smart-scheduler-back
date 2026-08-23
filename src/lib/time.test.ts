import { describe, expect, test } from "bun:test";
import { addDays, datesBetween, weekRange } from "./time";

// 🔴 REQ-069 / TASK-175. `weekRange` had NO test at all — which is precisely how a Sunday-start week survived
// against a Monday-start calendar for months, hiding every Sunday booking on the customer's busiest day. The
// cases below are written from the calendar the staff actually look at, not from the code.
describe("weekRange is Monday→Sunday (REQ-069)", () => {
  // 2026-07-27 Mon · 28 Tue · 29 Wed · 30 Thu · 31 Fri · 08-01 Sat · 08-02 Sun
  const MON = "2026-07-27";
  const SUN = "2026-08-02";

  test("Monday is the START of its own week, not the middle of the last one", () => {
    expect(weekRange(MON)).toEqual({ start: MON, end: SUN });
  });

  test("a midweek day resolves to the same Mon→Sun block", () => {
    for (const d of ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01"]) {
      expect(weekRange(d)).toEqual({ start: MON, end: SUN });
    }
  });

  test("🔴 AC-1: on a SUNDAY you get the week that Sunday ENDS — the old code gave the next one", () => {
    // The defect in one assertion. Sunday is their busiest day, and it was being drawn as the empty first
    // column of a week that had not started yet.
    expect(weekRange(SUN)).toEqual({ start: MON, end: SUN });
    expect(weekRange(SUN).start).not.toBe(SUN);
  });

  test("every day of a week maps to the same seven dates, and Sunday is one of them", () => {
    const week = datesBetween(MON, SUN);
    expect(week).toHaveLength(7);
    expect(week[6]).toBe(SUN); // Sunday is the LAST column, and it is inside the range
    for (const d of week) expect(datesBetween(weekRange(d).start, weekRange(d).end)).toEqual(week);
  });

  test("the range is always exactly 7 days, across a month and a year boundary", () => {
    for (const d of ["2026-08-31", "2026-12-31", "2027-01-01", "2026-02-28"]) {
      const { start, end } = weekRange(d);
      expect(addDays(start, 6)).toBe(end);
      expect(datesBetween(start, end)).toHaveLength(7);
    }
  });
});
