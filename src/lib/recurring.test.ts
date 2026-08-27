import { describe, expect, test } from "bun:test";
import { courseExpiry, courseSessionDates, importedCourseExpiry, isCourseSize, weekdayOf } from "./recurring";
import { addDays } from "./time";

describe("recurring course (B.4)", () => {
  test("session dates are weekly, length = size", () => {
    const dates = courseSessionDates("2026-07-05", 4); // Sunday
    expect(dates).toEqual(["2026-07-05", "2026-07-12", "2026-07-19", "2026-07-26"]);
  });

  test("10-session course generates 10 weekly dates", () => {
    expect(courseSessionDates("2026-07-01", 10)).toHaveLength(10);
  });

  test("expiry = start + max-week ceiling (4→5wk, 6→8wk, 10→13wk)", () => {
    expect(courseExpiry("2026-07-01", 4)).toBe("2026-08-05"); // +35d
    expect(courseExpiry("2026-07-01", 6)).toBe("2026-08-26"); // +56d
    expect(courseExpiry("2026-07-01", 10)).toBe("2026-09-30"); // +91d
  });

  test("weekdayOf: 2026-07-05 is Sunday(0)", () => {
    expect(weekdayOf("2026-07-05")).toBe(0);
    expect(weekdayOf("2026-07-06")).toBe(1);
  });

  test("isCourseSize guards 4/6/10 only", () => {
    expect(isCourseSize(4)).toBe(true);
    expect(isCourseSize(6)).toBe(true);
    expect(isCourseSize(10)).toBe(true);
    expect(isCourseSize(5)).toBe(false);
  });
});

// ═══ FIX-007 / TASK-195 — course expiry is COMPUTED on both creation paths ═══
//
// This decides whether a live family reads as `EXPIRED` on the course list, so the tests are written from the
// owner's own worked example and his table, not from the code.
describe("courseExpiry — the native create path (AC-1)", () => {
  test("4 / 6 / 10 sessions expire 5 / 8 / 13 weeks after the start date", () => {
    // The 6→8 entry carried "an ASSUMPTION — confirm" for months; the owner confirmed all three from one
    // table in FIX-007, so it is pinned here rather than left as a comment nobody can act on.
    expect(courseExpiry("2026-03-01", 4)).toBe(addDays("2026-03-01", 5 * 7));
    expect(courseExpiry("2026-03-01", 6)).toBe(addDays("2026-03-01", 8 * 7));
    expect(courseExpiry("2026-03-01", 10)).toBe(addDays("2026-03-01", 13 * 7));
  });

  test("expiry is a function of the start date alone — nothing else moves it (AC-2)", () => {
    // A leave cannot change expiry because expiry never reads anything a leave touches.
    expect(courseExpiry("2026-03-01", 10)).toBe(courseExpiry("2026-03-01", 10));
  });
});

describe("importedCourseExpiry — an imported course lands under the same ceiling (AC-7)", () => {
  test("🔴 the owner's worked example: 10 sessions, 4 taught, first remaining 5 Feb", () => {
    // realStart = 5 Feb − 4 weeks = 8 Jan; expiry = 8 Jan + 13 weeks = 9 Apr.
    expect(importedCourseExpiry("2026-02-05", 10, 4)).toBe("2026-04-09");
  });

  test("it IS `courseExpiry` from the reconstructed start — one rule, two entry points", () => {
    // Stated as an identity rather than a second arithmetic: if the two ever disagree, that is the bug.
    for (const [size, prior] of [[4, 1], [6, 3], [10, 7]] as const) {
      const realStart = addDays("2026-05-04", -prior * 7);
      expect(importedCourseExpiry("2026-05-04", size, prior)).toBe(courseExpiry(realStart, size));
    }
  });

  test("nothing taught yet ⇒ identical to a native course starting that day", () => {
    expect(importedCourseExpiry("2026-05-04", 6, 0)).toBe(courseExpiry("2026-05-04", 6));
  });

  test("🔑 a course imported near its end expires SOONER than a naive start+ceiling — the point of the fix", () => {
    // 9 of 10 taught: the family has weeks left, not thirteen. Taking a typed-in date, or computing from the
    // first remaining session, would both have handed them a fresh 13-week window they did not buy.
    const naive = courseExpiry("2026-05-04", 10);
    expect(importedCourseExpiry("2026-05-04", 10, 9) < naive).toBe(true);
  });

  test("a nonsense prior count cannot push expiry into the future (negatives clamp to 0)", () => {
    expect(importedCourseExpiry("2026-05-04", 6, -5)).toBe(courseExpiry("2026-05-04", 6));
    expect(importedCourseExpiry("2026-05-04", 6, 2.7)).toBe(importedCourseExpiry("2026-05-04", 6, 2));
  });
});
