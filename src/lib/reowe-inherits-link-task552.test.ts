// TASK-552 (B) — a gap opened by CANCELLING a make-up is re-owed to THAT make-up's own leave (the cancelled row's written link).
// 🔑 Not the one-line planner change: "a cancelled row still matches" is DELIBERATELY kept — pause → resume and a gap-filling insert
// answer leaves WITHOUT a link, and that rule covers them until TASK-553 writes those links. Pinned here so the gap stays visible.
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { planCourseMoves } from "./course-plan";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { reowedForOf } = await import("../services/scheduler.service");
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8"));
type S = { id: string; status: string; date: string; extendedFromId: string | null; isMakeup: boolean };
const r = (id: string, status: string, date: string, extendedFromId: string | null = null): S => ({ id, status, date, extendedFromId, isMakeup: status === "EXTENDED" || extendedFromId !== null }); // 🔻 TASK-702 — a fixture make-up carries the MARKER, as the backfill marks it
// A 4-session course: L took a leave; its make-up M1 was CANCELLED by an admin (D7, sid e7cb8771 → 0494ab85).
const D7 = [r("s1", "CONFIRMED", "2026-10-01"), r("L", "SICK_LEAVE", "2026-10-08"), r("s3", "CONFIRMED", "2026-10-15"), r("s4", "CONFIRMED", "2026-10-22"), r("M1", "CANCELLED", "2026-10-29", "L")];

describe("🔑 the pure planner — the re-owe inherits the cancelled make-up's leave; nothing else moves", () => {
  test("D7 reproduced and FIXED: re-owed for L ⇒ the new class names L (it named nobody)", () => {
    expect(planCourseMoves(D7, 4, ["L"]).append).toEqual([{ extendedFromId: "L" }]);
    expect(planCourseMoves(D7, 4).append).toEqual([{ extendedFromId: null }]); // no inheritance passed ⇒ the old answer, unchanged
  });
  test("🚫 the PAUSE case is unchanged (no link to inherit ⇒ the old attribution: the NEW leave keeps its own make-up)", () => {
    const paused = [r("s1", "ATTENDED", "2026-09-01"), r("Lold", "SICK_LEAVE", "2026-09-08"), r("p1", "CANCELLED", "2026-09-15"), r("M1", "CANCELLED", "2026-09-29", "Lold"),
      r("r1", "CONFIRMED", "2026-11-02"), r("L3", "SICK_LEAVE", "2026-11-09"), r("r3", "CONFIRMED", "2026-11-16")];
    expect(planCourseMoves(paused, 4).append).toEqual([{ extendedFromId: "L3" }]);
    expect(planCourseMoves(paused, 4, []).append).toEqual([{ extendedFromId: "L3" }]);
  });
  test("never a double answer: a leave that already has a LIVE make-up is not re-owed to again; a non-leave id is ignored", () => {
    const live = [...D7.filter((x) => x.id !== "s4"), r("M2", "EXTENDED", "2026-11-05", "L")];
    expect(planCourseMoves(live, 4, ["L"]).append).toEqual([{ extendedFromId: null }]);
    expect(planCourseMoves(D7, 4, ["s1"]).append).toEqual([{ extendedFromId: null }]); // s1 is not a leave
  });
  test("the inherited leave goes FIRST, then the oldest-gap rule for any further append", () => {
    const two = [r("s1", "CONFIRMED", "2026-10-01"), r("L2", "SICK_LEAVE", "2026-10-02"), r("L", "SICK_LEAVE", "2026-10-08"), r("s4", "CONFIRMED", "2026-10-22"), r("M1", "CANCELLED", "2026-10-29", "L")];
    expect(planCourseMoves(two, 4, ["L"]).append).toEqual([{ extendedFromId: "L" }, { extendedFromId: "L2" }]);
  });
  test("🔑 the one-line rule change is DELIBERATELY absent: a cancelled row still counts as matched (TASK-553 lands it after the links)", () => {
    const P = code(readFileSync(resolve(root, "src/lib/course-plan.ts"), "utf8"));
    expect(P).toContain("sessions.map((s) => s.extendedFromId).filter((x): x is string => x !== null),");
  });
});

describe("the inheritance comes ONLY from the row's own written link", () => {
  test("linked ⇒ [its leave] · an unlinked make-up ⇒ [] and SAID · an ordinary session ⇒ [] silently", () => {
    const logs: string[] = [];
    const spy = spyOn(console, "info").mockImplementation(((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }) as any);
    try {
      expect(reowedForOf({ id: "m", status: "EXTENDED", extendedFromId: "L" })).toEqual(["L"]);
      expect(reowedForOf({ id: "c", status: "CONFIRMED", extendedFromId: "L" })).toEqual(["L"]); // a confirmed make-up is still a make-up
      expect(logs).toEqual([]);
      expect(reowedForOf({ id: "m-bare", status: "EXTENDED", extendedFromId: null, isMakeup: true })).toEqual([]);
      expect(logs).toEqual(["[TASK-552] cancelled make-up m-bare carries no link — its re-owe inherits NO leave (TASK-553)"]);
      // 🔻 TASK-702 — a make-up is born CONFIRMED, so "is this a make-up?" is the MARKER: a CONFIRMED unlinked MARKED make-up says so too, an ordinary CONFIRMED class never does
      expect(reowedForOf({ id: "m-conf", status: "CONFIRMED", extendedFromId: null, isMakeup: true })).toEqual([]);
      expect(logs).toEqual(["[TASK-552] cancelled make-up m-bare carries no link — its re-owe inherits NO leave (TASK-553)", "[TASK-552] cancelled make-up m-conf carries no link — its re-owe inherits NO leave (TASK-553)"]);
      logs.length = 1;
      expect(reowedForOf({ id: "s", status: "CONFIRMED", extendedFromId: null })).toEqual([]);
      expect(logs.length).toBe(1); // an ordinary session is not a make-up: nothing to say
    } finally { spy.mockRestore(); }
  });
  test("by source: EXACTLY the three cancel-then-re-plan paths pass it (the admin's cancel · a coach's leave · a group date's seats)", () => {
    expect((SVC.match(/reowedFor: reowedForOf\(/g) ?? []).length).toBe(3);
    expect(SVC).toContain("replanned = await reconcileCoursePlan(tx, current.courseId, { reowedFor: reowedForOf(current) });");
    expect(SVC).toContain("const replanned = b.courseId ? await reconcileCoursePlan(tx, b.courseId, { reowedFor: reowedForOf(b as any) }) : null;");
    expect(SVC).toContain("const replanned = s.courseId ? await reconcileCoursePlan(tx, s.courseId, { reowedFor: reowedForOf(s) }) : null;");
  });
  test("🚫 pause → resume and the plan editor's insert / mark-absence are UNCHANGED (no inheritance on those paths) — the gap stays visible", () => {
    const resume = SVC.slice(SVC.indexOf("export async function resumeCourse("), SVC.indexOf("export async function endCourse("));
    expect(resume).not.toContain("reowedFor");
    const plan = SVC.slice(SVC.indexOf("export async function applyPlanChange("), SVC.indexOf("export async function applyPlanChange(") + 20000);
    expect(plan).toContain("const moves = await reconcileCoursePlan(tx, courseId);");
    expect(plan.slice(0, plan.indexOf("} else if (action ===") > 0 ? plan.indexOf("} else if (action ===") : undefined)).not.toContain("reowedFor");
  });
});
