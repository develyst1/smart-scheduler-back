import { describe, expect, test } from "bun:test";
import { freelanceDraw, overLimit } from "./freelance-budget";

describe("freelanceDraw — local cap/draw (TASK-019)", () => {
  test("draw exactly to zero", () => {
    expect(freelanceDraw(50000, 50000, false)).toEqual({ blocked: false, remainingAfter: 0 });
  });
  test("draw with room left", () => {
    expect(freelanceDraw(120000, 50000, false)).toEqual({ blocked: false, remainingAfter: 70000 });
  });
  test("insufficient budget, no override → blocked (remaining untouched)", () => {
    expect(freelanceDraw(20000, 50000, false)).toEqual({ blocked: true, remainingAfter: 20000 });
  });
  test("override allows the draw to go negative", () => {
    expect(freelanceDraw(20000, 50000, true)).toEqual({ blocked: false, remainingAfter: -30000 });
  });
});

describe("overLimit", () => {
  test("remaining ≤ 0 → over limit (FE hides the teacher)", () => {
    expect(overLimit(0)).toBe(true);
    expect(overLimit(-1)).toBe(true);
    expect(overLimit(1)).toBe(false);
  });
});
