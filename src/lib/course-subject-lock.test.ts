// TASK-134 (SPEC-042 / REQ-053) — the guard both write paths call: `applyPlanChange`'s move branch and
// `moveBooking`. What matters is that a course session refuses a subject CHANGE, a no-op still passes
// (idempotency), and voucher / single / trial keep their editable subject (AC-4).
import { describe, expect, test } from "bun:test";
import { COURSE_SUBJECT_LOCKED, changesCourseSubject } from "./course-subject-lock";

const courseSession = { subjectId: "subj-surfskate", courseId: "course-1" };
const voucherSession = { subjectId: "subj-surfskate", courseId: null };

describe("changesCourseSubject (TASK-134)", () => {
  test("course session + a DIFFERENT subject → refused (AC-2, both paths)", () => {
    expect(changesCourseSubject(courseSession, "subj-bike")).toBe(true);
  });

  test("course session + the SAME subject → passes (a re-sent payload stays idempotent)", () => {
    expect(changesCourseSubject(courseSession, "subj-surfskate")).toBe(false);
  });

  test("course session with no subjectId in the patch → passes (date/time/teacher-only move)", () => {
    expect(changesCourseSubject(courseSession, undefined)).toBe(false);
    expect(changesCourseSubject(courseSession, null)).toBe(false);
  });

  test("voucher / single / trial session (courseId null) → still editable (AC-4)", () => {
    expect(changesCourseSubject(voucherSession, "subj-bike")).toBe(false);
  });

  test("the code is the typed one the FE surfaces", () => {
    expect(COURSE_SUBJECT_LOCKED).toBe("COURSE_SUBJECT_LOCKED");
  });
});
