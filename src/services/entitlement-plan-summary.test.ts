// TASK-263 — the entitlement plan summary must carry the lifecycle, and must AGREE with `toCourseSummary`.
//
// 🔴 The defect this closes was invisible in the only way that matters: the rule was right and the input was
// wrong. `PlanModal` asked `plan.summary.status` — correct question, correct predicate — and the payload had
// never carried the field, so the answer was `undefined` on every course. The pause control never hid, and the
// resume button rendered on nothing. @Fern: *"a unit test of the predicate alone would have passed on the
// broken build."* ⇒ the assertions here are about the PAYLOAD's field list, not about any rule.
//
// 📌 And this is the THIRD hand-copied projection of `toCourseSummary` in this codebase to lose a lifecycle
// field: TASK-198 added `droppedAt`, TASK-205 found the search-count copy that had not grown with it, and this
// one had lost three. So the test that matters is not "status is present" — it is **"nothing is missing"**,
// derived from the builder rather than from a list someone has to remember to extend.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { toCourseSummary, type CourseLike } from "../lib/leave";

const SVC = readSrc(await Bun.file("src/services/scheduler.service.ts").text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

/**
 * A course row shaped like the DB's, in each lifecycle state the FE renders differently.
 *
 * ⚠️ `size: 10` because `PackageSize` is `4 | 6 | 10` — I first wrote `8` and the compiler caught it. Worth a
 * line: `toCourseSummary` casts (`c.size as PackageSize`), so an impossible size would have flowed through
 * the runtime silently and only the TYPE said no.
 */
const baseCourse: CourseLike & { studentId: string } = {
  id: "c-1",
  studentId: "s-1",
  size: 10,
  usedSessions: 3,
  leaveUsed: 1,
  adminUnlocked: false,
  leaveQuota: null,
  expiryDate: "2026-12-31",
  endedAt: null,
  endReason: null,
  droppedAt: null,
  dropReason: null,
};
const ACTIVE = { ...baseCourse };
const DROPPED = { ...baseCourse, droppedAt: new Date("2026-09-01T00:00:00Z"), dropReason: "family travel" };
const ENDED = { ...baseCourse, endedAt: new Date("2026-08-20T00:00:00Z"), endReason: "COMPLETED" };

/**
 * The plan summary as `getEntitlementPlan` now builds it. Reproduced here rather than reached through the
 * service because the service needs a database — and TASK-263's whole subject is the SHAPE, which is decidable
 * without one. The source assertion below pins that this really is what the service does.
 */
const planSummary = (course: CourseLike, owedCount: number) => ({
  ...toCourseSummary(course, "2026-09-06"),
  kind: "course" as const,
  owedCount,
});

describe("TASK-263 — the plan summary carries the lifecycle", () => {
  test("🔴 status, endedAt and endReason are all present — the three that were missing", () => {
    const s = planSummary(ACTIVE, 5);
    // Asserted by KEY, not by truthiness: `endedAt: null` on an active course is a correct answer and the
    // defect looked exactly like it — `undefined` and `null` read the same through `?? fallback`.
    expect("status" in s).toBe(true);
    expect("endedAt" in s).toBe(true);
    expect("endReason" in s).toBe(true);
    expect(s.status).toBe("ACTIVE");
    expect(s.endedAt).toBeNull();
  });

  test("a DROPPED course reports DROPPED, and says when and why", () => {
    // The owner's report, at the payload: the FE hid nothing because this said `undefined`.
    const s = planSummary(DROPPED, 5);
    expect(s.status).toBe("DROPPED");
    expect(s.droppedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(s.dropReason).toBe("family travel");
  });

  test("an ended course reads CANCELLED — SummaryBar's notice can finally render", () => {
    // `PlanModal`'s SummaryBar has read `summary.endedAt` / `summary.endReason` since REQ-036 and could never
    // show anything, because the payload carried neither. A third symptom of the one omission.
    //
    // ⚠️ The STATUS is `CANCELLED`, not `ENDED` — I expected `ENDED` writing this and `course-status.ts:46`
    // corrected me: `endedAt != null` is terminal cancellation, while `COMPLETED` is the used-up course
    // (`usedSessions >= size`). `endReason: "COMPLETED"` is the admin's REASON for ending it and is not the
    // status. Asserted together here so the next reader does not have to make the same mistake twice.
    const s = planSummary(ENDED, 0);
    expect(s.status).toBe("CANCELLED");
    expect(s.endedAt).toBe("2026-08-20T00:00:00.000Z");
    expect(s.endReason).toBe("COMPLETED");
  });

  test("a used-up course reads COMPLETED — the other terminal state, and it has no endedAt", () => {
    const s = planSummary({ ...baseCourse, usedSessions: 10 }, 0);
    expect(s.status).toBe("COMPLETED");
    expect(s.endedAt).toBeNull();
  });
});

describe("TASK-263 — the two summaries AGREE on the same course", () => {
  test("🔑 every field of toCourseSummary survives into the plan summary, with the same value", () => {
    // The point of the task, and the guard against a fourth divergence: the expectation is DERIVED from the
    // builder, so a field added to `toCourseSummary` tomorrow is covered here without anyone editing this file.
    for (const course of [ACTIVE, DROPPED, ENDED]) {
      const canonical = toCourseSummary(course, "2026-09-06");
      const plan = planSummary(course, 5);
      for (const [key, value] of Object.entries(canonical)) {
        // `owedCount` is the one deliberate override and is not a `toCourseSummary` field at all.
        expect({ key, value: (plan as Record<string, unknown>)[key] }).toEqual({ key, value });
      }
    }
  });

  test("🚫 …and the one plan-specific field still wins, because it is applied AFTER the spread", () => {
    // Order matters: written before the spread, `owedCount` would be silently dropped — and a plan that always
    // owes `undefined` is the same class of bug one field along.
    expect(planSummary(ACTIVE, 3).owedCount).toBe(3);
    expect("owedCount" in toCourseSummary(ACTIVE, "2026-09-06")).toBe(false);
  });

  test("the fields the old literal listed were already identical — nothing was being corrected by hand", () => {
    // Why the spread is safe rather than merely tidier: every field the projection named agreed with the
    // builder's already. The projection was not encoding a difference; it was only forgetting.
    const canonical = toCourseSummary(ACTIVE, "2026-09-06");
    expect(canonical.size).toBe(10);
    expect(canonical.expiryDate).toBe(ACTIVE.expiryDate);
    const plan = planSummary(ACTIVE, 5);
    for (const key of ["size", "leaveUsed", "leaveQuota", "maxWeek", "expiryDate"] as const) {
      expect({ key, v: plan[key] }).toEqual({ key, v: canonical[key] });
    }
  });
});

describe("TASK-263 — the service really is built this way", () => {
  test("🚫 the plan summary is a SPREAD, not a projection", () => {
    const c = code(SVC);
    const block = c.slice(c.indexOf("export async function getEntitlementPlan"));
    const summary = block.slice(block.indexOf("      summary: {"), block.indexOf("  const voucher ="));
    expect(summary).toContain("...summary,");
    expect(summary).toContain('kind: "course" as const,');
    expect(summary).toContain("owedCount: Math.max(0, courseOwedTarget(course) - current),");
    // The five fields it used to hand-copy must NOT come back as literals — that is the regression.
    for (const dead of ["size: course.size", "leaveUsed: summary.leaveUsed", "maxWeek: summary.maxWeek"]) {
      expect(summary).not.toContain(dead);
    }
    // 🚫 And no second lifecycle derivation here (TASK-189: one server `status`).
    expect(summary).not.toContain("courseStatus(");
  });

  test("🚫 no second `status` rule anywhere in the plan builder", () => {
    const c = code(SVC);
    const block = c.slice(
      c.indexOf("export async function getEntitlementPlan"),
      c.indexOf("export async function getEntitlementPlan") + 4000,
    );
    expect(block).toContain("const summary = toCourseSummary(course);");
    expect(block.match(/toCourseSummary\(/g)!.length).toBe(1);
  });
});
