import { describe, expect, test } from "bun:test";
import { formatWorkDaysLabel, teacherWorksOnDay, WEEKDAY_DAYS, WEEKEND_DAYS } from "./work-days";

describe("teacherWorksOnDay", () => {
  test("empty = every day", () => {
    expect(teacherWorksOnDay([], 1)).toBe(true);
    expect(teacherWorksOnDay(null, 6)).toBe(true);
  });

  test("weekend only", () => {
    expect(teacherWorksOnDay(WEEKEND_DAYS, 6)).toBe(true);
    expect(teacherWorksOnDay(WEEKEND_DAYS, 0)).toBe(true);
    expect(teacherWorksOnDay(WEEKEND_DAYS, 2)).toBe(false);
  });

  test("sunday only", () => {
    expect(teacherWorksOnDay([0], 0)).toBe(true);
    expect(teacherWorksOnDay([0], 6)).toBe(false);
  });
});

describe("formatWorkDaysLabel", () => {
  test("labels", () => {
    expect(formatWorkDaysLabel([0, 1, 2, 3, 4, 5, 6])).toBe("ทุกวัน");
    expect(formatWorkDaysLabel(WEEKEND_DAYS)).toBe("เสาร์–อาทิตย์");
    expect(formatWorkDaysLabel(WEEKDAY_DAYS)).toBe("จ–ศ (วันธรรมดา)");
    expect(formatWorkDaysLabel([0])).toBe("อา");
    expect(formatWorkDaysLabel([6])).toBe("ส");
  });
});
