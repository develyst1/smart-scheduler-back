import { describe, expect, test } from "bun:test";
import {
  formatBlastRadius,
  planCourseCleanup,
  planHouseholdRemoval,
  type CleanupInput,
} from "./course-cleanup-plan";

// SPEC-062 / TASK-177 (REQ-057). This tool deletes rows on the customer's live box, so the tests are mostly
// about the cases where it must REFUSE. A delete tool is judged by what it declines to do.
const input = (o: Partial<CleanupInput> = {}): CleanupInput => ({
  course: { id: "c1", size: 10, source: "IMPORT", usedSessions: 4, startDate: "2026-08-25" },
  bookings: [
    { id: "b1", date: "2026-09-08", status: "CONFIRMED" },
    { id: "b2", date: "2026-08-25", status: "CONFIRMED" },
    { id: "b3", date: "2026-09-01", status: "PENDING" },
  ],
  student: { id: "s1", name: "ทดสอบ ระบบ", nickname: "เทส" },
  parent: { id: "p1", name: "ผู้ปกครองทดสอบ", lineUserId: null, studentCount: 1 },
  postedSaleRefIds: [],
  ...o,
});

describe("planCourseCleanup — the refusals (AC-3/AC-8)", () => {
  test("the Test-course case passes: an IMPORT course with usedSessions 4 and nothing attended", () => {
    const plan = planCourseCleanup(input());
    expect(plan.ok).toBe(true);
    expect(plan.refusals).toEqual([]);
  });

  test("🔴 `usedSessions > 0` is NOT a refusal — on an IMPORT it is the count taught before the import", () => {
    // Refusing on it would make the tool useless for the one course the owner actually needs to remove.
    expect(planCourseCleanup(input({ course: { id: "c1", size: 10, source: "IMPORT", usedSessions: 9, startDate: "2026-08-25" } })).ok).toBe(true);
  });

  test("🔴 an ATTENDED session refuses, and names the dates — something really happened here", () => {
    const plan = planCourseCleanup(
      input({ bookings: [{ id: "b1", date: "2026-08-25", status: "ATTENDED" }] }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.refusals.join()).toContain("ATTENDED");
    expect(plan.refusals.join()).toContain("2026-08-25");
  });

  test("🔴 a posted sale refuses — the books must not reference a course that no longer exists", () => {
    const plan = planCourseCleanup(input({ postedSaleRefIds: ["c1"] }));
    expect(plan.ok).toBe(false);
    expect(plan.refusals.join()).toContain("ลงบัญชีแล้ว");
  });

  test("🔴 a LINE-linked parent refuses — a test household does not link LINE", () => {
    const plan = planCourseCleanup(
      input({ parent: { id: "p1", name: "จริง", lineUserId: "U123", studentCount: 1 } }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.refusals.join()).toContain("LINE");
  });

  test("🔴 a parent with more than one child refuses — that is a real family", () => {
    const plan = planCourseCleanup(
      input({ parent: { id: "p1", name: "จริง", lineUserId: null, studentCount: 3 } }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.refusals.join()).toContain("3");
  });

  test("every reason is reported at once — the owner should not discover them one run at a time", () => {
    const plan = planCourseCleanup(
      input({
        bookings: [{ id: "b1", date: "2026-08-25", status: "ATTENDED" }],
        postedSaleRefIds: ["c1"],
        parent: { id: "p1", name: "จริง", lineUserId: "U1", studentCount: 2 },
      }),
    );
    expect(plan.refusals).toHaveLength(4);
  });
});

describe("planCourseCleanup — the blast radius (AC-1/AC-10)", () => {
  test("counts are exactly what a COMMIT would delete, and dates read in order", () => {
    const plan = planCourseCleanup(input());
    expect(plan.counts).toEqual({ bookings: 3, course_packages: 1 });
    expect(plan.bookingDates).toEqual(["2026-08-25", "2026-09-01", "2026-09-08"]);
  });

  test("a course with no bookings left is still deletable, and says so honestly", () => {
    const plan = planCourseCleanup(input({ bookings: [] }));
    expect(plan.ok).toBe(true);
    expect(plan.counts.bookings).toBe(0);
  });

  test("the printed radius names people, not ids", () => {
    const i = input();
    const out = formatBlastRadius(i, planCourseCleanup(i)).join("\n");
    expect(out).toContain("ทดสอบ ระบบ (เทส)");
    expect(out).toContain("ผู้ปกครองทดสอบ");
    expect(out).not.toContain("c1"); // an id the owner would have to go look up is not a blast radius
  });
});

describe("planHouseholdRemoval — the guards that keep this off a real family (AC-2)", () => {
  test("the fake household passes all three guards", () => {
    expect(planHouseholdRemoval(input({ studentHasOtherEntitlements: false })).ok).toBe(true);
  });

  test("refuses when the student still owns anything else", () => {
    const r = planHouseholdRemoval(input({ studentHasOtherEntitlements: true }));
    expect(r.ok).toBe(false);
    expect(r.refusals.join()).toContain("คอร์ส/บัตร");
  });

  test("refuses a multi-child or LINE-linked parent", () => {
    expect(planHouseholdRemoval(input({ parent: { id: "p1", name: "x", lineUserId: null, studentCount: 2 } })).ok).toBe(false);
    expect(planHouseholdRemoval(input({ parent: { id: "p1", name: "x", lineUserId: "U1", studentCount: 1 } })).ok).toBe(false);
  });

  test("no parent at all ⇒ nothing to remove, and it says that rather than crashing", () => {
    const r = planHouseholdRemoval(input({ parent: null }));
    expect(r.ok).toBe(false);
    expect(r.refusals).toHaveLength(1);
  });

  test("🔑 the household decision is SEPARATE — its refusal must not block the course cleanup", () => {
    const i = input({ parent: { id: "p1", name: "x", lineUserId: null, studentCount: 1 }, studentHasOtherEntitlements: true });
    expect(planHouseholdRemoval(i).ok).toBe(false);
    expect(planCourseCleanup(i).ok).toBe(true); // the course still goes
  });
});
