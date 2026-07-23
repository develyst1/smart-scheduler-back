import { describe, expect, test } from "bun:test";
import { drawCeilingHour, overLimit } from "./freelance-budget";

describe("drawCeilingHour — 1h ceiling draw (TASK-024)", () => {
  test("draws one hour when within the ceiling", () => {
    expect(drawCeilingHour(140, false)).toEqual({ blocked: false, remainingAfter: 139 });
  });
  test("last hour draws to zero", () => {
    expect(drawCeilingHour(1, false)).toEqual({ blocked: false, remainingAfter: 0 });
  });
  test("no hours left, no override → blocked (remaining untouched)", () => {
    expect(drawCeilingHour(0, false)).toEqual({ blocked: true, remainingAfter: 0 });
  });
  test("override allows going negative", () => {
    expect(drawCeilingHour(0, true)).toEqual({ blocked: false, remainingAfter: -1 });
  });
});

describe("overLimit", () => {
  test("remaining ≤ 0 → over limit (FE hides the teacher)", () => {
    expect(overLimit(0)).toBe(true);
    expect(overLimit(-1)).toBe(true);
    expect(overLimit(1)).toBe(false);
  });
});
