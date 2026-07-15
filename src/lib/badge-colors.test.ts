import { describe, expect, test } from "bun:test";
import { BADGE_COLORS, isBadgeColor } from "./badge-colors";

describe("badge colour palette", () => {
  test("palette is non-empty and unique", () => {
    expect(BADGE_COLORS.length).toBeGreaterThan(0);
    expect(new Set(BADGE_COLORS).size).toBe(BADGE_COLORS.length);
  });

  test("isBadgeColor accepts palette keys, rejects others", () => {
    expect(isBadgeColor("blue")).toBe(true);
    expect(isBadgeColor("#ff0000")).toBe(false);
    expect(isBadgeColor("chartreuse")).toBe(false);
    expect(isBadgeColor("")).toBe(false);
  });
});
