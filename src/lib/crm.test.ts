import { describe, expect, test } from "bun:test";
import {
  applyPoints,
  levelFromPoints,
  CRM_POINT_RULES,
  perksForLevel,
  crmLevelLadder,
} from "./crm";

describe("crm (C.2)", () => {
  test("levelFromPoints thresholds", () => {
    expect(levelFromPoints(0).level).toBe(1);
    expect(levelFromPoints(30).level).toBe(2);
    expect(levelFromPoints(300).level).toBe(5);
  });

  test("applyPoints never goes negative", () => {
    expect(applyPoints(5, -100).points).toBe(0);
  });

  test("point rules are positive", () => {
    expect(CRM_POINT_RULES.ON_TIME_CHECKIN).toBeGreaterThan(0);
    expect(CRM_POINT_RULES.PROPER_SICK_LEAVE).toBeGreaterThan(0);
  });

  test("perks: low levels have no priority booking, high levels do", () => {
    expect(perksForLevel(1).priorityBooking).toBe(false);
    expect(perksForLevel(2).priorityBooking).toBe(false);
    expect(perksForLevel(3).priorityBooking).toBe(true);
    expect(perksForLevel(5).priorityBooking).toBe(true);
    expect(perksForLevel(5).perks.length).toBeGreaterThan(perksForLevel(1).perks.length);
  });

  test("perks: unknown level falls back to level 1", () => {
    expect(perksForLevel(99)).toEqual(perksForLevel(1));
  });

  test("ladder pairs every level with its perks", () => {
    const ladder = crmLevelLadder();
    expect(ladder).toHaveLength(5);
    expect(ladder[0]).toMatchObject({ level: 1, minPoints: 0, priorityBooking: false });
    expect(ladder[4]).toMatchObject({ level: 5, priorityBooking: true });
  });
});
