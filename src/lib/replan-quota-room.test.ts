// 🔻 TASK-308 (REQ-085 §12) — **TASK-302's remaining-quota room is REVERTED, and this file is the record.**
//
// It used to assert that a re-planned course's expiry reached PAST its last session by the leave the family
// still had — so the extension ceiling would not refuse that leave.
//
// 🔴 `§12` removed the refusal itself: **the quota is the only gate on leave, and the expiry stretches to fit
// when a leave is actually taken.** ⇒ **with nothing left to refuse, there is nothing to leave room FOR**, and a
// pre-allocated week made the card's `expires` date claim time the family had not used.
// 🔑 **Stretch on demand is simpler and more honest.** 📌 TASK-302's term was the right fix for the rule as we
// then understood it; `§12` removes the need for it, not the reasoning behind it.
//
// 🚫 REWRITTEN rather than deleted: a behaviour removed on a ruling deserves an assertion that it stays
// removed, and the properties TASK-302 protected that SURVIVE are still asserted below.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { courseBornCeiling, replanExpiry } from "./course-plan";
import { addDays } from "./time";
import { courseExpiry, importedCourseExpiry } from "./recurring";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const OLD_EXPIRY = "2026-10-20";
const LAST = "2026-12-01"; // the re-plan's last session, past the old expiry

describe("🔻 TASK-308 — the pre-allocated week is gone", () => {
  test("🔑 a re-plan's expiry lands ON its last session, not a quota-week past it", () => {
    // The whole revert in one assertion. It used to return `LAST + remainingQuota weeks`.
    expect(replanExpiry(OLD_EXPIRY, LAST)).toBe(LAST);
  });

  test("🚫 …and the same is true at CREATION — no quota term there either", () => {
    // A 4-session course with three declared absences: the plan ends week 7 and the ceiling ends week 7.
    const START = "2026-09-01";
    const week = (n: number) => addDays(START, (n - 1) * 7);
    expect(courseBornCeiling(courseExpiry(START, 4), week(4), 3)).toBe(week(7));
  });

  test("📌 the arithmetic is gone from the source, not just from the result", () => {
    // So nobody re-adds it believing it was an oversight.
    const PLAN = code(src("src/lib/course-plan.ts"));
    expect(PLAN).not.toContain("quota * 7");
    expect(PLAN).toContain("export function courseBornCeiling(base: string, lastPlanned: string, absences: number): string {");
  });
});

describe("✅ TASK-302's surviving properties — the ones §12 did not touch", () => {
  test("🚫 the expiry still COVERS the last planned session — DEF-4's guarantee", () => {
    // TASK-282's rule, which §12 leans on rather than replaces.
    expect(replanExpiry(OLD_EXPIRY, LAST) >= LAST).toBe(true);
  });

  test("🚫 it still never SHRINKS — a re-plan finishing early leaves the old expiry alone", () => {
    expect(replanExpiry("2026-12-31", "2026-11-24")).toBe("2026-12-31");
    // …and `recordExpiryChange` still writes nothing when nothing moved.
    const SVC = code(src("src/services/scheduler.service.ts"));
    const writer = SVC.slice(SVC.indexOf("async function recordExpiryChange("));
    expect(writer.slice(0, writer.indexOf("\n}"))).toContain("if (row.from === row.to) return;");
  });

  test("nothing owed ⇒ no last session ⇒ nothing moves", () => {
    expect(replanExpiry("2026-12-31", null)).toBe("2026-12-31");
  });

  test("🔑 ONE arithmetic for one sentence — `replanExpiry` IS `courseBornCeiling` with no absences", () => {
    // 🚫 Two arithmetics for one promise is the class this week has been about. Asserted by AGREEMENT, so a
    // change to either that does not change the other fails here.
    expect(replanExpiry(OLD_EXPIRY, LAST)).toBe(courseBornCeiling(OLD_EXPIRY, LAST, 0));
    expect(code(src("src/lib/course-plan.ts"))).toContain(
      "lastSession ? courseBornCeiling(currentExpiry, lastSession, 0) : currentExpiry;",
    );
  });

  test("🚫 the quota and `leaveUsed` are still read, never written, by the resume", () => {
    // §12 removes a gate; it grants no extra leaves — and the resume no longer reads the quota at all now that
    // it allocates no room from it.
    const SVC = code(src("src/services/scheduler.service.ts"));
    const resume = SVC.slice(
      SVC.indexOf("export async function resumeCourse("),
      SVC.indexOf("export async function endCourse("),
    );
    expect(resume).not.toContain("leaveUsed:");
    expect(resume).not.toContain("leaveQuota:");
  });
});

describe("🔑 the lifecycle property, restated for §12", () => {
  // 🔻 TASK-302's property was *"a course's ceiling always leaves room for its remaining quota"*. **That is no
  // longer the rule** — and it does not need to be: the expiry now GROWS when a leave is taken, so the room is
  // created on demand rather than reserved in advance.
  // ⇒ The property that survives is TASK-282's: **every computing path leaves the expiry covering the plan.**
  const START = "2026-09-01";
  const week = (n: number) => addDays(START, (n - 1) * 7);

  test("CREATED · IMPORTED · RE-PLANNED all cover their own plan's end", () => {
    const rows = [
      { path: "created", ceiling: courseBornCeiling(courseExpiry(START, 4), week(4), 3), planEnd: week(7) },
      { path: "imported", ceiling: importedCourseExpiry(START, 6, 0, 2), planEnd: week(6) },
      { path: "replanned", ceiling: replanExpiry(OLD_EXPIRY, LAST), planEnd: LAST },
    ];
    expect(rows.map((r) => ({ path: r.path, ok: r.ceiling >= r.planEnd }))).toEqual([
      { path: "created", ok: true },
      { path: "imported", ok: true },
      { path: "replanned", ok: true },
    ]);
  });
});
