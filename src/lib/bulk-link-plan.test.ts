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

// ═══ TASK-223 — the header must not document a policy the owner revoked ═══
//
// 🔴 A comment asserting a revoked policy is worse than no comment: it is the reason someone runs the command
// confidently. This header said `link-all` was for both boxes, and that open-by-default was a trade-off the
// owner had accepted. On 2026-08-29 he said **"ตั้งใจจำกัด"** — DC and Pop are deliberately restricted — and a
// `--commit` on `uat` would have given DC 16 programs he is not meant to teach, with **no way to unlink**.
// Prose rots silently, so the claims that matter are pinned here (the TASK-191 lesson, applied to comments).
//
// ⚠️ Asserted on the SOURCE TEXT, never by importing the script: importing it would construct the DB client.
const SCRIPT = await Bun.file(new URL("../../scripts/link-all-teacher-subjects.ts", import.meta.url)).text();
const PLAN_SRC = await Bun.file(new URL("./bulk-link-plan.ts", import.meta.url)).text();

describe("TASK-223 — what the header is allowed to claim", () => {
  test("🔴 neither file says the tool is for `uat`, or that open-by-default is current policy", () => {
    // Not even as a quotation: a grep that finds the revoked wording hands the reader the old policy out of
    // context, which is exactly the failure mode being fixed.
    expect(SCRIPT).not.toContain("on BOTH `sid` and `uat`");
    expect(SCRIPT).not.toContain("อย่าลืมรันทั้ง sid และ uat");
    expect(SCRIPT).not.toContain("the trade-off the owner accepted when he chose open-by-default");
    expect(SCRIPT).not.toContain("Usage (run on sid, then uat)");
  });

  test("🔴 it names all three: `sid`-only · `uat` = a named list · it can NEVER unlink", () => {
    expect(SCRIPT).toContain("sid`-ONLY");
    expect(SCRIPT).toContain("NAMED LIST");
    expect(SCRIPT).toContain("can NEVER unlink");
  });

  test("the revoked premise in the pure planner points at the script's danger paragraph", () => {
    // `bulk-link-plan.ts` repeated "every teacher can teach every program" as if it were still the roster.
    expect(PLAN_SRC).toContain("revoked for `uat`");
    expect(PLAN_SRC).toContain("link-all-teacher-subjects.ts");
  });

  test("🔴 item 3: the warning prints above the plan on BOTH paths, dry run AND --commit", () => {
    // SA correction at review: the person typing `--commit` is who it is for. A warning that vanishes at the
    // moment of danger fires only when it cannot matter.
    expect(SCRIPT).toContain("${UAT_WARNING}");
    expect(SCRIPT.indexOf("${UAT_WARNING}")).toBeLessThan(SCRIPT.indexOf("console.log(formatBulkLinkPlan(plan))"));
    expect(SCRIPT).toContain("this tool is sid-only");
    // Not gated on the dry-run flag — that gate is what the review struck.
    expect(SCRIPT).not.toContain("if (!commit) console.log(");
  });

  test("🔴 behaviour is UNCHANGED — dry run still rolls back, --commit still inserts on-conflict-do-nothing", () => {
    // The task is a comment fix. A safety guard nobody ordered (box detection, an env check) would be a
    // behaviour change, and getting "which box am I on" wrong in a guard is worse than a stale comment.
    expect(SCRIPT).toContain("if (!commit) throw new Error(DRY_RUN_ROLLBACK);");
    expect(SCRIPT).toContain(".onConflictDoNothing()");
    for (const guard of ["process.env.NODE_ENV", "DATABASE_URL", "isUat", "--force"]) {
      expect(SCRIPT).not.toContain(guard);
    }
  });
});
