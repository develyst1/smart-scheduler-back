// TASK-358 (`REQ-089 item 2`) — expiry with advance leave = the BASE ceiling + the leave weeks.
//
// 🔴 The customer's own example is the spec: *Kavya, size 6, starts 23/9, 3 weeks advance leave ⇒ expiry = 8 + 3
// = 11 weeks from start.* The system made it the LAST SESSION's week (9): the plan's make-ups ran to week 9 and
// the stretch was measured from there, so the quota's two weeks were eaten by the leaves.
// 🔑 Pinned by HIS numbers, because that is the only kind of assertion that could have caught it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { courseBornCeiling, replanExpiry } from "./course-plan";
import { courseExpiry, courseSessionDates } from "./recurring";
import { addDays } from "./time";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const START = "2026-09-23"; // Kavya's start, a Wednesday
const week = (n: number) => addDays(START, (n - 1) * 7);
/** The creation path's `lastPlanned`: the last of the uniform weekly chain — week `size`. */
const lastPlanned = (size: number) => courseSessionDates(START, size).at(-1)!;

describe("🔴 Kavya — the customer's numbers", () => {
  test("🔑 size 6, 0 leaves ⇒ week 8 — UNCHANGED, the base", () => {
    expect(courseExpiry(START, 6)).toBe(week(8));
    expect(courseBornCeiling(courseExpiry(START, 6), lastPlanned(6), 0)).toBe(week(8));
  });

  test("🔴 size 6, 3 weeks advance leave ⇒ week 11 (8 + 3), NOT week 9", () => {
    const born = courseBornCeiling(courseExpiry(START, 6), lastPlanned(6), 3);
    expect(born).toBe(week(11));
    expect(born).toBe(addDays(START, 10 * 7)); // 11 weeks from start, week 1 being the start week
    // ⚠️ THE OLD ANSWER, asserted absent: the last session's week.
    expect(born).not.toBe(week(9));
  });

  test("size 4, 1 leave ⇒ week 6 (5 + 1)", () => {
    expect(courseExpiry(START, 4)).toBe(week(5)); // 4 + quota 1
    expect(courseBornCeiling(courseExpiry(START, 4), lastPlanned(4), 1)).toBe(week(6));
  });

  test("📌 the unit is DISTINCT WEEKS declared absent — on a weekly course that equals sessions, which is every course today", () => {
    // The creation path passes `absentWeeks.size` — a Set of 1-based week numbers — so a week declared twice
    // counts once, and a course with one session per week has weeks === sessions. Asserted at the call.
    const SVC = code(src("src/services/scheduler.service.ts"));
    expect(SVC).toContain("const absentWeeks = new Set<number>((input.absentWeeks ?? []) as number[]);");
    // ⚠️ TASK-342's rule, applied to itself: the END anchor is searched FROM the start index — a bare `indexOf`
    // found an earlier `const [course] = await tx` and this region was EMPTY on the first run.
    const at = SVC.indexOf("const bornCeiling = courseBornCeiling(");
    const call = SVC.slice(at, SVC.indexOf("const [course] = await tx", at));
    expect(call).toContain("courseExpiry(input.startDate, input.size)"); // a positive over the SAME region
    expect(call).toContain("absentWeeks.size,");
  });
});

describe("🔑 ONE formula, and every path that sets a ceiling derives from it", () => {
  test("the formula is `base-or-plan-end, plus the absent weeks` — and it still never shrinks", () => {
    const PLAN = code(src("src/lib/course-plan.ts"));
    const fn = PLAN.slice(PLAN.indexOf("export function courseBornCeiling("), PLAN.indexOf("\n}\n", PLAN.indexOf("export function courseBornCeiling(")));
    expect(fn).toContain("const floor = lastPlanned > base ? lastPlanned : base;");
    expect(fn).toContain("return addDays(floor, absences * 7);");
    // 🚫 the old shape — stretch from the last session, then max — is gone.
    expect(fn).not.toContain("addDays(lastPlanned, absences * 7)");
    // never shrinks: a plan drawn PAST the base keeps its own end as the floor.
    expect(courseBornCeiling(week(5), week(9), 0)).toBe(week(9));
    expect(courseBornCeiling(week(5), week(9), 2)).toBe(week(11));
  });

  test("🔑 the RESUME path derives from the SAME function — `replanExpiry` is `courseBornCeiling(…, 0)` — not a copy", () => {
    // With absences = 0 the formula is `max(currentExpiry, lastSession)`, which is exactly what it was before
    // this task: a resumed course's ceiling does not move because of TASK-358, and there is no second source.
    const PLAN = code(src("src/lib/course-plan.ts"));
    expect(PLAN).toContain("lastSession ? courseBornCeiling(currentExpiry, lastSession, 0) : currentExpiry;");
    expect(replanExpiry(week(8), week(6))).toBe(week(8));
    expect(replanExpiry(week(8), week(10))).toBe(week(10));
    expect(replanExpiry(week(8), null)).toBe(week(8));
    // …and `resumeCourse` reaches it through `replanExpiry`, not through its own arithmetic.
    const SVC = code(src("src/services/scheduler.service.ts"));
    const resume = SVC.slice(SVC.indexOf("export async function resumeCourse("));
    expect(resume).toContain("const expiryDate = replanExpiry(course.expiryDate, lastSession);");
    expect(resume.slice(0, resume.indexOf("\n}\n"))).not.toContain("addDays(");
  });

  test("the creation PREVIEW uses the same function too — preview and save agree on Kavya's week 11", () => {
    const SVC = code(src("src/services/scheduler.service.ts"));
    expect((SVC.match(/courseBornCeiling\(/g) ?? []).length).toBe(2); // creation + preview, nothing else
    expect(SVC).not.toMatch(/absences \* 7|absentWeeks\.size \* 7/); // no arithmetic outside the one function
  });
});
