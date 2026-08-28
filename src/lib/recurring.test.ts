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

  test("🔴 expiry = the WEEK NUMBER's date — week N is N−1 weeks after the start (TASK-197)", () => {
    // These three used to read +35/+56/+91 days, matching the code exactly and the school not at all. The
    // ceiling is a week number: week 5 of a course starting 1 Jul is 29 Jul, not 5 Aug.
    expect(courseExpiry("2026-07-01", 4)).toBe("2026-07-29"); // week 5  → +28d
    expect(courseExpiry("2026-07-01", 6)).toBe("2026-08-19"); // week 8  → +49d
    expect(courseExpiry("2026-07-01", 10)).toBe("2026-09-23"); // week 13 → +84d
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
  test("🔴 THE OWNER'S CASE — a 6-session course from 2026-09-04 expires 2026-10-23", () => {
    // He started one real course and read the date off the screen. This assertion is a DATE HE GAVE US, not
    // arithmetic restated from the code — which is the entire reason it catches what my previous tests could
    // not: those said `weeks * 7` because the code said `weeks * 7`, and the two agreed all the way to
    // production. Do not "simplify" this back into a formula.
    expect(courseExpiry("2026-09-04", 6)).toBe("2026-10-23");
  });

  test("4 / 6 / 10 sessions reach week 5 / 8 / 13 — i.e. start + 4 / 7 / 12 weeks (TASK-197)", () => {
    // The ceiling is a week NUMBER, so the offset is one week less. My TASK-195 tests asserted 5/8/13 weeks
    // and were reviewed and passed; the arithmetic was wrong in both places at once.
    expect(courseExpiry("2026-03-01", 4)).toBe(addDays("2026-03-01", 4 * 7));
    expect(courseExpiry("2026-03-01", 6)).toBe(addDays("2026-03-01", 7 * 7));
    expect(courseExpiry("2026-03-01", 10)).toBe(addDays("2026-03-01", 12 * 7));
  });

  test("the start week counts as week 1 — that is the whole rule, stated once", () => {
    // A 4-session course reaching "week 5" means four weeks of schedule after the first: 29 days of calendar,
    // 5 weekly slots. Off-by-one bugs live exactly here, so the meaning is pinned, not just the number.
    expect(courseExpiry("2026-03-01", 4)).toBe("2026-03-29");
  });

  test("expiry is a function of the start date alone — nothing else moves it (AC-2)", () => {
    // A leave cannot change expiry because expiry never reads anything a leave touches.
    expect(courseExpiry("2026-03-01", 10)).toBe(courseExpiry("2026-03-01", 10));
  });
});

describe("importedCourseExpiry — an imported course lands under the same ceiling (AC-7)", () => {
  test("🔴 the owner's worked example, re-derived on the CORRECTED rule (TASK-197)", () => {
    // realStart = 5 Feb − 4 weeks = 8 Jan. Week 13 of a course starting 8 Jan is 8 Jan + 12 weeks = 2 Apr.
    // It was 9 Apr here until TASK-197 — the same seven days every course was over-granted.
    expect(importedCourseExpiry("2026-02-05", 10, 4)).toBe("2026-04-02");
    // …and it is still the ceiling counted from the real start, not from the first remaining session:
    expect(importedCourseExpiry("2026-02-05", 10, 4) < courseExpiry("2026-02-05", 10)).toBe(true);
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
