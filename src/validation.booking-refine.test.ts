// TASK-055 — the COURSE_PACKAGE backstop, sitting next to the existing voucher-refine behaviour it mirrors.
// Without `courseId` a course booking deducts nothing at check-in AND cuts nothing at end-of-day → a free
// session, and the course's remaining count drifts from reality (the number TASK-051's eligibility reads).
import { describe, expect, test } from "bun:test";
import { createBooking } from "./validation";

const base = {
  student: { id: "11111111-1111-4111-8111-111111111111" },
  teacherId: "22222222-2222-4222-8222-222222222222",
  subjectId: "33333333-3333-4333-8333-333333333333",
  date: "2026-08-05",
  startTime: "09:00",
};
const COURSE_ID = "44444444-4444-4444-8444-444444444444";
const VOUCHER_ID = "55555555-5555-4555-8555-555555555555";

describe("createBooking — COURSE_PACKAGE requires courseId (TASK-055)", () => {
  test("🚫 COURSE_PACKAGE with no courseId is rejected", () => {
    const r = createBooking.safeParse({ ...base, bookingType: "COURSE_PACKAGE" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes("courseId"))).toBe(true);
  });

  test("COURSE_PACKAGE with a courseId passes (unchanged behaviour)", () => {
    expect(createBooking.safeParse({ ...base, bookingType: "COURSE_PACKAGE", courseId: COURSE_ID }).success).toBe(true);
  });
});

describe("createBooking — the existing voucher rule still holds (symmetry check)", () => {
  test("🚫 VOUCHER with no voucherId is rejected", () => {
    expect(createBooking.safeParse({ ...base, bookingType: "VOUCHER" }).success).toBe(false);
  });

  test("VOUCHER with a voucherId passes", () => {
    expect(createBooking.safeParse({ ...base, bookingType: "VOUCHER", voucherId: VOUCHER_ID }).success).toBe(true);
  });
});

describe("createBooking — one-off types are unaffected by either refine", () => {
  test("FIRST_TRIAL and SINGLE_SESSION need neither id", () => {
    expect(createBooking.safeParse({ ...base, bookingType: "FIRST_TRIAL" }).success).toBe(true);
    expect(createBooking.safeParse({ ...base, bookingType: "SINGLE_SESSION" }).success).toBe(true);
  });
});
