import { describe, expect, test } from "bun:test";
import { hasEnoughLeaveNotice, leaveNoticeMinutes, minutesUntilClass } from "./leave-notice";

const now = { date: "2026-07-15", time: "10:00", minutes: 600 }; // 10:00

describe("leave advance-notice rules", () => {
  test("required notice by teacher type: FT/PT = 60, FL = 120", () => {
    expect(leaveNoticeMinutes("FULL_TIME")).toBe(60);
    expect(leaveNoticeMinutes("PART_TIME")).toBe(60);
    expect(leaveNoticeMinutes("FREELANCE")).toBe(120);
  });

  test("minutesUntilClass — same day", () => {
    expect(minutesUntilClass("2026-07-15", "12:00", now)).toBe(120);
    expect(minutesUntilClass("2026-07-15", "10:00", now)).toBe(0);
  });

  test("minutesUntilClass — spans days", () => {
    expect(minutesUntilClass("2026-07-16", "10:00", now)).toBe(1440);
    expect(minutesUntilClass("2026-07-14", "10:00", now)).toBe(-1440);
  });

  test("FT: enough at exactly 60 min, not at 59", () => {
    expect(hasEnoughLeaveNotice("2026-07-15", "11:00", "FULL_TIME", now)).toBe(true);
    expect(hasEnoughLeaveNotice("2026-07-15", "10:59", "FULL_TIME", now)).toBe(false);
  });

  test("FL needs 120 min: 90 min ahead is NOT enough", () => {
    expect(hasEnoughLeaveNotice("2026-07-15", "11:30", "FREELANCE", now)).toBe(false);
    expect(hasEnoughLeaveNotice("2026-07-15", "12:00", "FREELANCE", now)).toBe(true);
  });

  test("class already started / past → never enough notice", () => {
    expect(hasEnoughLeaveNotice("2026-07-15", "09:00", "FULL_TIME", now)).toBe(false);
  });
});
