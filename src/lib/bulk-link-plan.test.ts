// TASK-155 (SPEC-055 / REQ-058 req 6) — the matrix decision, on fixtures. What has to be exactly right here is
// WHO is excluded: an archived teacher must never be linked, a paused one must ALWAYS be.
import { describe, expect, test } from "bun:test";
import { formatBulkLinkPlan, planBulkLinks, type Pair } from "./bulk-link-plan";

const teachers = [
  { id: "t1", nickname: "ก้อง", archived: false },
  { id: "t2", nickname: "แนน", archived: false },
  { id: "t3", nickname: "เก่า", archived: true }, // offboarded — must get nothing
];
const subjects = [
  { id: "s1", name: "Bike", active: true },
  { id: "s2", name: "Surfskate", active: true },
  { id: "s3", name: "Retired program", active: false }, // must get nothing
];

describe("the cross-product, minus what already exists", () => {
  test("nothing linked yet → every live teacher × every live program", () => {
    const p = planBulkLinks({ teachers, subjects, existingPairs: [] });
    expect(p.teacherCount).toBe(2); // the archived one is not counted
    expect(p.subjectCount).toBe(2); // nor the inactive program
    expect(p.toCreate).toHaveLength(4);
    expect(p.skipped).toHaveLength(0);
  });

  test("partly linked → ONLY the gaps are created", () => {
    const existing: Pair[] = [
      { teacherId: "t1", subjectId: "s1" },
      { teacherId: "t2", subjectId: "s2" },
    ];
    const p = planBulkLinks({ teachers, subjects, existingPairs: existing });
    expect(p.toCreate).toEqual([
      { teacherId: "t1", subjectId: "s2" },
      { teacherId: "t2", subjectId: "s1" },
    ]);
    expect(p.skipped).toHaveLength(2);
  });

  test("a finished pass re-runs to ZERO — this is the idempotency the owner relies on", () => {
    const all = planBulkLinks({ teachers, subjects, existingPairs: [] }).toCreate;
    const again = planBulkLinks({ teachers, subjects, existingPairs: all });
    expect(again.toCreate).toHaveLength(0);
    expect(again.skipped).toHaveLength(4);
  });
});

describe("who is excluded, and who is deliberately NOT", () => {
  test("an ARCHIVED teacher gets no links at all — linking offboarded staff is dead config", () => {
    const p = planBulkLinks({ teachers, subjects, existingPairs: [] });
    expect(p.toCreate.some((x) => x.teacherId === "t3")).toBe(false);
    expect(p.perTeacher.some((t) => t.nickname === "เก่า")).toBe(false);
  });

  test("an INACTIVE program gets no links", () => {
    expect(planBulkLinks({ teachers, subjects, existingPairs: [] }).toCreate.some((x) => x.subjectId === "s3")).toBe(false);
  });

  test("🔑 a PAUSED (active:false) teacher IS linked — pause is availability, not capability", () => {
    const paused = [{ id: "t9", nickname: "พัก", archived: false }]; // not archived ⇒ included
    const p = planBulkLinks({ teachers: paused, subjects, existingPairs: [] });
    expect(p.toCreate).toHaveLength(2);
  });

  test("no live teachers or no live programs → nothing to do, and it doesn't throw", () => {
    expect(planBulkLinks({ teachers: [], subjects, existingPairs: [] }).toCreate).toHaveLength(0);
    expect(planBulkLinks({ teachers, subjects: [], existingPairs: [] }).toCreate).toHaveLength(0);
  });
});

describe("operator evidence (AC-10)", () => {
  test("the summary states N × M and the per-teacher tally", () => {
    const out = formatBulkLinkPlan(planBulkLinks({ teachers, subjects, existingPairs: [{ teacherId: "t1", subjectId: "s1" }] }));
    expect(out).toContain("ครู 2 × โปรแกรม 2 = 4 ลิงก์");
    expect(out).toContain("จะสร้างใหม่ 3 · มีอยู่แล้ว 1");
    expect(out).toContain("ก้อง: +1 / =1");
    expect(out).not.toContain("เก่า"); // the archived teacher isn't even listed
  });
});
