import { describe, expect, test } from "bun:test";
import { courseExpiry, courseSessionDates, isCourseSize, weekdayOf } from "./recurring";

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
