// TASK-138 (SPEC-045 / REQ-054) — the create-course boundary guard: a per-session override may repeat the
// course's subject but must never introduce a second one, or the course is born mixed-program.
import { describe, expect, test } from "bun:test";
import { createCoursePackage } from "./validation";

const SUBJ_A = "11111111-1111-4111-8111-111111111111";
const SUBJ_B = "22222222-2222-4222-8222-222222222222";
const TEACHER = "33333333-3333-4333-8333-333333333333";

const base = {
  student: { name: "น้องเอ", parentPhone: "0812345678" },
  teacherId: TEACHER,
  subjectId: SUBJ_A,
  size: 4 as const,
  startDate: "2026-09-01",
  startTime: "09:00",
};
const dates = ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"];

describe("createCoursePackage — one course, one program (TASK-138)", () => {
  test("a session carrying a DIFFERENT subject is refused (AC-2)", () => {
    const r = createCoursePackage.safeParse({
      ...base,
      sessions: dates.map((date, i) => ({ date, subjectId: i === 2 ? SUBJ_B : SUBJ_A })),
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("ทุกคาบในคอร์สต้องเป็นกิจกรรมเดียวกัน");
  });

  test("sessions that all repeat the course subject pass", () => {
    expect(createCoursePackage.safeParse({ ...base, sessions: dates.map((date) => ({ date, subjectId: SUBJ_A })) }).success).toBe(true);
  });

  test("sessions with no per-row subjectId pass (they inherit the course subject)", () => {
    expect(createCoursePackage.safeParse({ ...base, sessions: dates.map((date) => ({ date })) }).success).toBe(true);
  });

  test("no sessions[] at all still passes (the uniform weekly chain, unchanged)", () => {
    expect(createCoursePackage.safeParse(base).success).toBe(true);
  });

  test("the session-count rule is untouched by the new refine", () => {
    expect(createCoursePackage.safeParse({ ...base, sessions: [{ date: dates[0]! }] }).success).toBe(false);
  });
});

// TASK-148 (SPEC-049 / REQ-045) — the boundary rules for absences declared at creation.
describe("createCoursePackage — absentWeeks (TASK-148)", () => {
  test("a week inside the course is accepted, and so is no absence at all (AC-4)", () => {
    expect(createCoursePackage.safeParse({ ...base, absentWeeks: [3] }).success).toBe(true);
    expect(createCoursePackage.safeParse({ ...base, absentWeeks: [] }).success).toBe(true);
    expect(createCoursePackage.safeParse(base).success).toBe(true);
  });

  test("consecutive absent weeks are allowed (Q2 = yes)", () => {
    expect(createCoursePackage.safeParse({ ...base, absentWeeks: [2, 3] }).success).toBe(true);
  });

  test("a week beyond the course size is refused, not silently ignored", () => {
    const r = createCoursePackage.safeParse({ ...base, absentWeeks: [5] }); // size 4
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("สัปดาห์ที่ลาต้องอยู่ในช่วงของคอร์ส");
  });

  test("every week absent is refused — that is not a course", () => {
    const r = createCoursePackage.safeParse({ ...base, absentWeeks: [1, 2, 3, 4] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("ต้องมีคาบที่เรียนจริงอย่างน้อย 1 คาบ");
  });

  test("week 0 / negative / fractional are rejected by the shape", () => {
    for (const w of [0, -1, 1.5]) {
      expect(createCoursePackage.safeParse({ ...base, absentWeeks: [w] }).success).toBe(false);
    }
  });
});
