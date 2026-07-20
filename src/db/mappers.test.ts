import { describe, expect, test } from "bun:test";
import { toTeacherDTO } from "./mappers";

describe("toTeacherDTO budget fields (TASK-008)", () => {
  test("carries satang budget fields, defaulting until quotas/override are attached", () => {
    const dto = toTeacherDTO({
      id: "t1",
      name: "Alice",
      nickname: "อลิซ",
      type: "FREELANCE",
      active: true,
      workDays: [1, 2, 3],
    });
    expect(dto).toMatchObject({
      id: "t1",
      type: "FREELANCE",
      hourlyRate: null,
      budgetMinor: null,
      remainingMinor: null,
      reorderMinor: null,
      overLimit: false,
      limitOverride: false,
    });
    // old hours-based field is gone (renamed to remainingMinor, satang)
    expect("quotaRemaining" in dto).toBe(false);
  });
});
