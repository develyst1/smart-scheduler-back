// TASK-553 — every answer to a leave carries its link. §1's ORDER is the finding: writers link → backfill → THEN the one
// planner line ("a cancelled row no longer matches"). This file pins steps 1 and 2, and pins WHY step 3 must wait.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { leavesAwaitingReanswer, planCourseMoves, type PlanSession } from "./course-plan";
import { backfillSummary, planLeaveLinkBackfill, type BackfillRow } from "./leave-link-backfill";

const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const fnBody = (s: string, head: string) => { const a = s.indexOf(head); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf("\n}\n", a)); };
const S = (id: string, date: string, status: string, extendedFromId: string | null = null): PlanSession => ({ id, date, status, extendedFromId, isMakeup: status === "EXTENDED" || extendedFromId !== null, bookingType: "COURSE_PACKAGE" }); // 🔻 TASK-702 — a fixture make-up carries the MARKER, as the backfill marks it

/** What step 3's planner line would answer: the oldest leave with NO LIVE linked row (a cancelled row no longer matches). */
const lineWouldPick = (sessions: PlanSession[]) => {
  const live = new Set(sessions.filter((s) => s.status !== "CANCELLED" && s.extendedFromId).map((s) => s.extendedFromId));
  return sessions.filter((s) => s.status === "SICK_LEAVE" && !live.has(s.id)).sort((a, b) => a.date.localeCompare(b.date))[0]?.id ?? null;
};

describe("🔑 `leavesAwaitingReanswer` — answered once, that answer CANCELLED, no live answer by link", () => {
  test("by value: only L1 (its make-up cancelled); L2 is answered live; a declared-at-creation leave (never answered) is NOT here", () => {
    const rows = [S("L0", "2026-10-01", "SICK_LEAVE"), S("L1", "2026-10-08", "SICK_LEAVE"), S("L2", "2026-10-15", "SICK_LEAVE"),
      S("M1", "2026-11-05", "CANCELLED", "L1"), S("M2", "2026-11-12", "EXTENDED", "L2")];
    expect(leavesAwaitingReanswer(rows)).toEqual(["L1"]);
    expect(leavesAwaitingReanswer([...rows, S("M1b", "2026-11-19", "PENDING", "L1")])).toEqual([]); // re-answered BY LINK ⇒ done
  });
});

describe("🔴 WHY the order: the two writers' cases on the future planner line — old data breaks, linked data is right", () => {
  // A size-4 course: b1..b4, leave L1 on b2's date with make-up M1; the course is paused (M1 + the rest cancelled) and resumed.
  const paused = [S("b1", "2026-10-01", "ATTENDED"), S("L1", "2026-10-08", "SICK_LEAVE"), S("b3", "2026-10-15", "CANCELLED"), S("b4", "2026-10-22", "CANCELLED"), S("M1", "2026-10-29", "CANCELLED", "L1")];
  const resumedOld = [...paused, S("r1", "2026-11-05", "PENDING"), S("r2", "2026-11-12", "PENDING"), S("r3", "2026-11-19", "PENDING")];
  const resumedNew = [...paused, S("r1", "2026-11-05", "PENDING"), S("r2", "2026-11-12", "PENDING"), S("r3", "2026-11-19", "PENDING", "L1")]; // the writer: the LAST row answers L1
  const thenL3 = (rows: PlanSession[]) => rows.map((s) => (s.id === "r2" ? { ...s, status: "SICK_LEAVE" } : s)); // a NEW leave on r2 (id r2 = "L3")
  test("PAUSE → RESUME: unlinked (today's data) ⇒ the line would answer the PRE-PAUSE leave L1 for the new leave — D7's shape; linked ⇒ r2 itself", () => {
    expect(lineWouldPick(thenL3(resumedOld))).toBe("L1"); // ❌ the wrong leave: why the line cannot land before the backfill
    expect(lineWouldPick(thenL3(resumedNew))).toBe("r2"); // ✅ with the writer's link
    expect(planCourseMoves(thenL3(resumedOld), 4).append).toEqual([{ extendedFromId: "r2" }]); // today's rule is still right on both (the line is NOT landed)
    expect(planCourseMoves(thenL3(resumedNew), 4).append).toEqual([{ extendedFromId: "r2" }]);
  });
  test("ADMIN INSERT: the insert x answered L1 when M1 was trimmed — unlinked ⇒ the line picks L1 for the next leave; linked ⇒ right", () => {
    const base = [S("b1", "2026-10-01", "ATTENDED"), S("L1", "2026-10-08", "SICK_LEAVE"), S("b3", "2026-10-15", "PENDING"), S("b4", "2026-10-22", "PENDING"), S("M1", "2026-10-29", "CANCELLED", "L1")];
    const insertOld = [...base, S("x", "2026-10-11", "PENDING")];
    const insertNew = [...base, S("x", "2026-10-11", "PENDING", "L1")]; // the writer: the insert carries the trimmed make-up's leave
    const leaveOnB4 = (rows: PlanSession[]) => rows.map((s) => (s.id === "b4" ? { ...s, status: "SICK_LEAVE" } : s));
    expect(lineWouldPick(leaveOnB4(insertOld))).toBe("L1"); // ❌
    expect(lineWouldPick(leaveOnB4(insertNew))).toBe("b4"); // ✅
  });
});

describe("🔴 step 1 — BOTH writers write the link (by source; the rule they read is pinned by value above)", () => {
  const SVC = code("src/services/scheduler.service.ts");
  test("RESUME: the leaves awaiting an answer are read from the rows BEFORE the resume; the LAST re-laid rows carry them, oldest first", () => {
    const R = fnBody(SVC, "export async function resumeCourse(");
    expect(R).toContain("const awaiting = leavesAwaitingReanswer(rows.map(");
    expect(R).toContain("const linkCount = Math.min(awaiting.length, dates.length);");
    expect(R).toContain("const slot = i - (dates.length - linkCount);");
    expect(R).toContain("extendedFromId: slot >= 0 ? awaiting[slot] : null,");
    expect(R.indexOf("leavesAwaitingReanswer(")).toBeLessThan(R.indexOf("insertBooking(")); // read before anything is written
    expect(R).not.toContain("update(bookings)"); // born linked — TASK-282 §7's "no existing row touched" still holds
    expect(fnBody(SVC, "export async function insertBooking(")).toContain("extendedFromId: input.extendedFromId ?? null,");
  });
  test("INSERT: after the trim, the new row carries the leave a TRIMMED row pointed at; an unlinked trim yields nothing and says so", () => {
    const P = fnBody(SVC, "export async function applyPlanChange(");
    const ins = P.slice(P.indexOf('if (change.kind === "insert")'), P.indexOf('return await finalize({ change: "insert" as const'));
    expect(ins.indexOf("reconcileCoursePlan(tx, courseId)")).toBeLessThan(ins.indexOf("leavesAwaitingReanswer("));
    expect(ins).toContain("const answers = trimmed.map((r: any) => r.extendedFromId).find((l: string | null) => l && awaiting.has(l)) ?? null;");
    expect(ins).toContain("if (answers) await tx.update(bookings).set({ extendedFromId: answers }).where(eq(bookings.id, newId));");
    expect(ins).toContain("[TASK-553] insert");
  });
  test("🚫 step 3 is NOT landed: the planner's `matched` still reads every row (TASK-552's pin stays true until the backfill is reviewed)", () => {
    expect(fnBody(code("src/lib/course-plan.ts"), "export function planCourseMoves(")).toContain("sessions.map((s) => s.extendedFromId).filter((x): x is string => x !== null),");
  });
});

describe("🔴 step 2 — the BACKFILL links only on UNIQUE evidence; an ambiguous row is LEFT ALONE and COUNTED", () => {
  const C0 = new Date("2026-09-01T00:00:00Z"), later = (d: string) => new Date(`${d}T03:00:00Z`);
  const R = (id: string, status: string, extendedFromId: string | null, createdAt: Date, date = "2026-10-01"): BackfillRow => ({ id, date, status, extendedFromId, bookingType: "COURSE_PACKAGE", createdAt });
  const creation = [R("b1", "ATTENDED", null, C0), R("L1", "SICK_LEAVE", null, C0, "2026-10-08"), R("b3", "PENDING", null, C0), R("b4", "PENDING", null, C0)];
  test("the INSERT shape ⇒ ONE leave, ONE later unlinked row ⇒ linked", () => {
    const p = planLeaveLinkBackfill([{ id: "c1", createdAt: C0, rows: [...creation, R("M1", "CANCELLED", "L1", later("2026-09-10")), R("x", "PENDING", null, later("2026-09-10"))] }]);
    expect(p.link).toEqual([{ courseId: "c1", rowId: "x", leaveId: "L1" }]);
    expect(backfillSummary(p)).toMatchObject({ linked: 1, ambiguous: 0, notApplicable: 0 });
  });
  test("🔑 the RESUME shape ⇒ several re-laid rows could answer it ⇒ AMBIGUOUS, nothing linked (the writer's 'last row' is a convention, never a backfill guess)", () => {
    const rows = [...creation, R("M1", "CANCELLED", "L1", later("2026-09-10")), R("r1", "PENDING", null, later("2026-09-20")), R("r2", "PENDING", null, later("2026-09-20")), R("r3", "PENDING", null, later("2026-09-20"))];
    const p = planLeaveLinkBackfill([{ id: "c1", createdAt: C0, rows }]);
    expect([p.link, p.ambiguous]).toEqual([[], [{ courseId: "c1", leaveId: "L1", reason: "several-candidates", candidates: 3 }]]);
  });
  test("two leaves awaiting ⇒ BOTH ambiguous ('several-leaves'); none found ⇒ 'no-candidate'", () => {
    const two = [...creation, R("L2", "SICK_LEAVE", null, C0, "2026-10-15"), R("M1", "CANCELLED", "L1", later("2026-09-10")), R("M2", "CANCELLED", "L2", later("2026-09-11")), R("x", "PENDING", null, later("2026-09-12"))];
    expect(planLeaveLinkBackfill([{ id: "c1", createdAt: C0, rows: two }]).ambiguous.map((a) => [a.leaveId, a.reason])).toEqual([["L1", "several-leaves"], ["L2", "several-leaves"]]);
    const none = [...creation, R("M1", "CANCELLED", "L1", later("2026-09-10"))];
    expect(planLeaveLinkBackfill([{ id: "c1", createdAt: C0, rows: none }]).ambiguous).toEqual([{ courseId: "c1", leaveId: "L1", reason: "no-candidate", candidates: 0 }]);
  });
  test("🚫 never a candidate: a row written WITH the course · a row written BEFORE the cancelled answer · a row already linked · a cancelled / paused / leave row", () => {
    const rows = [...creation, R("old", "PENDING", null, later("2026-09-05")), R("M1", "CANCELLED", "L1", later("2026-09-10")), R("linked", "EXTENDED", "zzz", later("2026-09-12")),
      R("gone", "CANCELLED", null, later("2026-09-12")), R("paused", "PAUSED", null, later("2026-09-12")), R("x", "CONFIRMED", null, later("2026-09-12"))];
    expect(planLeaveLinkBackfill([{ id: "c1", createdAt: C0, rows }]).link).toEqual([{ courseId: "c1", rowId: "x", leaveId: "L1" }]);
  });
  test("🔑 a make-up created WITH the course (a leave declared at purchase) — the course's own rows are still never candidates", () => {
    // `since` = the cancelled answer's time = the course's own timestamp here, so only "not written with the course" keeps b3/b4 out
    const rows = [...creation, R("M1", "CANCELLED", "L1", C0), R("x", "PENDING", null, later("2026-09-12"))];
    expect(planLeaveLinkBackfill([{ id: "c1", createdAt: C0, rows }]).link).toEqual([{ courseId: "c1", rowId: "x", leaveId: "L1" }]);
  });
  test("not applicable = every other leave (answered live, or never answered); a course with none awaiting is untouched", () => {
    const rows = [...creation, R("L2", "SICK_LEAVE", null, C0, "2026-10-15"), R("M2", "EXTENDED", "L2", later("2026-09-10"))];
    expect(backfillSummary(planLeaveLinkBackfill([{ id: "c1", createdAt: C0, rows }]))).toMatchObject({ linked: 0, ambiguous: 0, notApplicable: 2 });
  });
  test("the script: dry run by default (rolled back), counts on the console, ids to gitignored project-docs, writes only a still-NULL link", () => {
    const s = readFileSync(resolve(root, "scripts/backfill-leave-links.ts"), "utf8");
    expect(s).toContain('const commit = process.argv.includes("--commit");');
    expect(s).toContain("if (!commit) throw new Error(DRY_RUN_ROLLBACK);");
    expect(s).toContain("await tx.update(bookings).set({ extendedFromId: l.leaveId }).where(and(eq(bookings.id, l.rowId), isNull(bookings.extendedFromId)));");
    expect(s).toContain("../project-docs/leave-link-backfill-");
  });
});
