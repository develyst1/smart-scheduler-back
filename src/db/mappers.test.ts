import { describe, expect, test } from "bun:test";
import { toCourseWithStudent, toTeacherDTO } from "./mappers";

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

describe("toCourseWithStudent — sport program (subject) derived from bookings (TASK-034)", () => {
  const base = {
    id: "c1",
    size: 10,
    usedSessions: 2,
    leaveUsed: 0,
    adminUnlocked: false,
    expiryDate: "2026-09-01",
    student: { id: "s1", name: "น้องโอ๊ด", nickname: "โอ๊ด" },
  };

  test("derives subject from the course's first booking", () => {
    const dto = toCourseWithStudent({
      ...base,
      bookings: [{ subject: { id: "sub1", name: "Balance Bike" } }],
    });
    expect(dto.subject).toEqual({ id: "sub1", name: "Balance Bike" });
  });

  test("subject is null when bookings aren't loaded / empty (safe for other callers)", () => {
    expect(toCourseWithStudent(base).subject).toBeNull();
    expect(toCourseWithStudent({ ...base, bookings: [] }).subject).toBeNull();
  });

  // TASK-140 — the course's own column is the source of truth; the booking derivation is now only a fallback
  // for rows that predate 0018's back-fill.
  test("the course's own subject wins over the first booking's", () => {
    const dto = toCourseWithStudent({
      ...base,
      subject: { id: "sub-course", name: "Surfskate" },
      bookings: [{ subject: { id: "sub1", name: "Balance Bike" } }],
    });
    expect(dto.subject).toEqual({ id: "sub-course", name: "Surfskate" });
  });

  test("a course with no subject_id yet still derives from its booking (pre-0018 rows)", () => {
    const dto = toCourseWithStudent({
      ...base,
      subject: null,
      bookings: [{ subject: { id: "sub1", name: "Balance Bike" } }],
    });
    expect(dto.subject).toEqual({ id: "sub1", name: "Balance Bike" });
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
