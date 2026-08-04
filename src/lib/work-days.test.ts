import { describe, expect, test } from "bun:test";
import {
  formatWorkDaysLabel,
  removedWorkDays,
  sessionsOnRemovedDays,
  teacherWorksOnDay,
  WEEKDAY_DAYS,
  WEEKEND_DAYS,
} from "./work-days";

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

describe("removedWorkDays — days a teacher stops working (TASK-100)", () => {
  test("narrowing to a subset removes the dropped days", () => {
    expect(removedWorkDays([1, 2, 3, 4, 5], [1, 2, 3])).toEqual([4, 5]);
  });

  test("empty means all-days on BOTH sides", () => {
    // all-days → weekdays-only drops Sat+Sun
    expect(removedWorkDays([], WEEKDAY_DAYS)).toEqual([0, 6]);
    // weekend-only → all-days (empty) removes nothing (widening)
    expect(removedWorkDays(WEEKEND_DAYS, [])).toEqual([]);
  });

  test("adding a day / no change removes nothing (no warning path)", () => {
    expect(removedWorkDays([1, 2, 3], [1, 2, 3, 4])).toEqual([]);
    expect(removedWorkDays([2, 6], [6, 2])).toEqual([]); // reorder/dupe-insensitive
  });

  test("swapping a day removes only the one dropped", () => {
    expect(removedWorkDays([1, 3], [1, 5])).toEqual([3]);
  });
});

describe("sessionsOnRemovedDays (TASK-100)", () => {
  test("keeps only sessions on a removed weekday", () => {
    const ss = [
      { id: "a", weekday: 3 },
      { id: "b", weekday: 5 },
      { id: "c", weekday: 3 },
    ];
    expect(sessionsOnRemovedDays(ss, [3]).map((s) => s.id)).toEqual(["a", "c"]);
    expect(sessionsOnRemovedDays(ss, [])).toEqual([]); // nothing removed → no orphans
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
