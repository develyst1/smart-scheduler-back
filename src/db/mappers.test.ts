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

describe("toTeacherDTO — dangling teacher_subjects row (TASK-029, availability 500 fix)", () => {
  test("skips a teacher_subjects row whose joined subject is missing instead of throwing", () => {
    const dto = toTeacherDTO({
      id: "t2",
      name: "Bob",
      nickname: "บ๊อบ",
      type: "PART_TIME",
      active: true,
      teacherSubjects: [
        { subject: { id: "s1", name: "Balance Bike" } },
        { subject: null }, // dangling row — used to crash `ts.subject.id`
        { subject: undefined },
      ],
    });
    expect(dto.subjects).toEqual([{ id: "s1", name: "Balance Bike" }]);
  });
});
