import { describe, expect, test } from "bun:test";
import { applyPoints, levelFromPoints, CRM_POINT_RULES } from "./crm";

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
});
