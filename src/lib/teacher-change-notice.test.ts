import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TEACHER_CHANGE_NOTICE_DAYS,
  daysUntilClass,
  hasEnoughTeacherChangeNotice,
  teacherChangeNoticeMessage,
} from "./teacher-change-notice";
import type { BangkokNow } from "./bangkok-time";

const now: BangkokNow = { date: "2026-08-10", time: "09:00", minutes: 540 };

describe("teacher-change notice — 3 days, floored (TASK-094)", () => {
  test("default is 3 days", () => {
    expect(DEFAULT_TEACHER_CHANGE_NOTICE_DAYS).toBe(3);
  });

  test("whole-day diff is floored — same clock time N days out = N days", () => {
    expect(daysUntilClass("2026-08-13", "09:00", now)).toBe(3);
    expect(daysUntilClass("2026-08-13", "08:00", now)).toBe(2); // 2d 23h → floor 2, NOT 3
  });

  test("boundary: exactly 3 days passes, under 3 fails (admin override is the caller's bypass)", () => {
    expect(hasEnoughTeacherChangeNotice("2026-08-13", "09:00", now)).toBe(true); // exactly 3
    expect(hasEnoughTeacherChangeNotice("2026-08-12", "09:00", now)).toBe(false); // 2 days
    expect(hasEnoughTeacherChangeNotice("2026-08-13", "08:00", now)).toBe(false); // 2d 23h
  });

  test("REQ-031-ready: the threshold can be overridden (pure, no app_settings)", () => {
    expect(hasEnoughTeacherChangeNotice("2026-08-12", "09:00", now, 2)).toBe(true); // 2-day rule
    expect(hasEnoughTeacherChangeNotice("2026-08-17", "09:00", now, 10)).toBe(false); // 10-day rule
  });

  test("message names the day count", () => {
    expect(teacherChangeNoticeMessage()).toContain("3");
    expect(teacherChangeNoticeMessage(5)).toContain("5");
  });
});
