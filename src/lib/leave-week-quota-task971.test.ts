// 🔻 TASK-971 step 2 (REQ-5016, SPEC-109 §3.3) — the leave QUOTA counts COURSE WEEKS for a pattern course. A charged leave increments `leave_used` only when no OTHER charged leave row of the course sits in the same course week; the undo returns
// a unit only when it removes the week's LAST charged leave row; a ONE-SLOT course takes none of this and runs today's exact path. By value (the pure rule, the gate, the two readers) and by source (both doors + the undo ask it).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { declarationTakesNewWeek, leaveTakesNewWeek, noOtherChargedLeaveInWeek, undoReturnsWeek, weekQuotaApplies } from "./leave-week-quota";
import { courseWeekOf } from "./course-pattern";

const root = resolve(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const START = "2026-11-02"; // a Monday: week 1 = 11-02 … 11-08, week 2 = 11-09 … 11-15

/** A recording executor: `slotCount` course_slots rows, the course's start date, and the OTHER charged-leave rows (by date). `calls` shows what was read. */
function exec(o: { slots?: number | null; others?: string[] } = {}) {
  const calls: string[] = [];
  const e: any = { query: {
    coursePackages: { findFirst: async () => { calls.push("course"); return { startDate: START }; } },
    bookings: { findMany: async () => { calls.push("others"); return (o.others ?? []).map((date) => ({ date })); } },
  } };
  if (o.slots !== null) e.query.courseSlots = { findMany: async () => { calls.push("slots"); return Array.from({ length: o.slots ?? 0 }, (_, i) => ({ id: `s${i}` })); } };
  return { e, calls };
}

describe("🔴 TASK-971 — the pure rule: no OTHER charged leave in the same course week", () => {
  test("same week ⇒ false; another week ⇒ true; nothing else ⇒ true", () => {
    expect(noOtherChargedLeaveInWeek(START, "2026-11-04", ["2026-11-06"])).toBe(false); // Wed + Fri of week 1
    expect(noOtherChargedLeaveInWeek(START, "2026-11-04", ["2026-11-11"])).toBe(true); // week 1 vs week 2
    expect(noOtherChargedLeaveInWeek(START, "2026-11-04", [])).toBe(true);
  });
  test("the week boundary is the COURSE's week (start + 7(k−1)), not the calendar's: day 7 (11-08) is week 1, day 8 (11-09) is week 2", () => {
    expect([courseWeekOf(START, "2026-11-08"), courseWeekOf(START, "2026-11-09")]).toEqual([1, 2]);
    expect(noOtherChargedLeaveInWeek(START, "2026-11-08", ["2026-11-09"])).toBe(true);
    expect(noOtherChargedLeaveInWeek(START, "2026-11-08", ["2026-11-02"])).toBe(false);
  });
  test("the course starts mid-week: week 1 runs from the start date, whatever its weekday", () => {
    expect(noOtherChargedLeaveInWeek("2026-11-04", "2026-11-04", ["2026-11-10"])).toBe(false); // 11-04 … 11-10 is week 1
    expect(noOtherChargedLeaveInWeek("2026-11-04", "2026-11-04", ["2026-11-11"])).toBe(true);
  });
});

describe("🔴 TASK-971 — the gate: a PATTERN course is one with 2+ `course_slots`; everything else is the one-slot course", () => {
  test("0 or 1 slot ⇒ false; 2 or 3 ⇒ true", async () => {
    for (const [n, want] of [[0, false], [1, false], [2, true], [3, true]] as const) expect({ n, applies: await weekQuotaApplies(exec({ slots: n }).e, "c1") }).toEqual({ n, applies: want });
  });
  test("an executor that carries no `courseSlots` relation (the older DB-free fakes) ⇒ false, no throw", async () => {
    expect(await weekQuotaApplies(exec({ slots: null }).e, "c1")).toBe(false);
  });
});

describe("🔴 TASK-971 — the quota in weeks: the two charged-leave doors and the undo", () => {
  test("ONE-SLOT course ⇒ every charged leave takes a unit and every undo returns one — and NOTHING else is read (today's path, byte for byte)", async () => {
    for (const slots of [0, 1]) {
      const a = exec({ slots, others: ["2026-11-04"] });
      expect(await leaveTakesNewWeek(a.e, "c1", "r1", "2026-11-04")).toBe(true); // even with another charged leave in the same week: a one-slot course never takes the week rule
      expect(await undoReturnsWeek(a.e, "c1", "r1", "2026-11-04")).toBe(true);
      expect(a.calls.filter((c) => c !== "slots")).toEqual([]);
    }
  });
  test("PATTERN course: a whole-day leave of 2 hours = ONE unit — the first charged row takes it, the second (same week) does not", async () => {
    expect(await leaveTakesNewWeek(exec({ slots: 2, others: [] }).e, "c1", "h1", "2026-11-04")).toBe(true); // 10:00 — nothing else charged yet
    expect(await leaveTakesNewWeek(exec({ slots: 2, others: ["2026-11-04"] }).e, "c1", "h2", "2026-11-04")).toBe(false); // 11:00 — the 10:00 row is already charged this week
  });
  test("PATTERN course: 2 single-hour leaves in ONE week = +1; in TWO weeks = +2", async () => {
    expect(await leaveTakesNewWeek(exec({ slots: 2, others: ["2026-11-04"] }).e, "c1", "x", "2026-11-06")).toBe(false); // same week
    expect(await leaveTakesNewWeek(exec({ slots: 2, others: ["2026-11-04"] }).e, "c1", "x", "2026-11-11")).toBe(true); // the next week
  });
  test("PATTERN course undo: undoing one of two charged leaves of a week returns NOTHING; the week's LAST returns the unit", async () => {
    expect(await undoReturnsWeek(exec({ slots: 2, others: ["2026-11-06"] }).e, "c1", "x", "2026-11-04")).toBe(false); // another charged row is still in the week
    expect(await undoReturnsWeek(exec({ slots: 2, others: [] }).e, "c1", "x", "2026-11-04")).toBe(true); // the last one
    expect(await undoReturnsWeek(exec({ slots: 2, others: ["2026-11-11"] }).e, "c1", "x", "2026-11-04")).toBe(true); // a charged row in ANOTHER week does not hold this week's unit
  });
  test("it reads only CHARGED SICK_LEAVE rows of THIS course, never the row itself (by the where-clause's parts)", () => {
    const S = read("src/lib/leave-week-quota.ts");
    expect(S).toContain('and(eq(b.courseId, courseId), eq(b.status, "SICK_LEAVE"), eq(b.leaveCharged, true), ne(b.id, rowId))');
  });
});

describe("🔒 TASK-971 — by source: both charged-leave doors and the undo ask the week rule (and nothing else moved)", () => {
  const SVC = read("src/services/scheduler.service.ts"), UNDO = read("src/services/undo.service.ts");
  test("door 2 (the plan editor's Mark absence) and door 1 (the sick-leave action) increment only when `leaveTakesNewWeek`", () => {
    expect(SVC).toContain("if (charged && (await leaveTakesNewWeek(tx, courseId, b.id, b.date))) {");
    expect(SVC).toContain("if (charges && (await leaveTakesNewWeek(tx, current.courseId, id, current.date))) {");
    expect(SVC.match(/leaveUsed: sql`\$\{coursePackages\.leaveUsed\} \+ 1`/g)).toHaveLength(2); // still exactly two increment sites
    expect(SVC).toContain('import { declarationTakesNewWeek, leaveTakesNewWeek } from "../lib/leave-week-quota";');
  });
  test("the undo returns a unit only when `undoReturnsWeek`; the floor (`GREATEST(… - 1, 0)`) is untouched", () => {
    expect(UNDO).toContain("if (leaveRefunded && (await undoReturnsWeek(tx, row.courseId, row.id, row.date))) {");
    expect(UNDO).toContain("leaveUsed: sql`GREATEST(${coursePackages.leaveUsed} - 1, 0)`");
  });
});

describe("🔴 TASK-971 rework (Silver's review) — a PRE-START declaration adds ONE week of expiry per COURSE WEEK declared, not per hour", () => {
  test("PATTERN course: a whole-day declaration of 2 hours ⇒ the first hour adds the week, the second (another declared absence in the same course week) does not", async () => {
    expect(await declarationTakesNewWeek(exec({ slots: 2, others: [] }).e, "c1", "h1", "2026-11-04")).toBe(true);
    expect(await declarationTakesNewWeek(exec({ slots: 2, others: ["2026-11-04"] }).e, "c1", "h2", "2026-11-04")).toBe(false);
  });
  test("PATTERN course: declared absences in TWO course weeks ⇒ two weeks (another week's declaration does not suppress this one)", async () => {
    expect(await declarationTakesNewWeek(exec({ slots: 2, others: ["2026-11-04"] }).e, "c1", "x", "2026-11-11")).toBe(true);
  });
  test("a ONE-slot course ⇒ always a new week (one row a week = today), and NOTHING else is read", async () => {
    const a = exec({ slots: 0, others: ["2026-11-04"] });
    expect(await declarationTakesNewWeek(a.e, "c1", "x", "2026-11-04")).toBe(true);
    expect(a.calls.filter((c) => c !== "slots")).toEqual([]);
  });
  test("it reads only the course's OTHER declared absences (SICK_LEAVE + planned_at_creation), never the row itself — by the where-clause's parts", () => {
    expect(read("src/lib/leave-week-quota.ts")).toContain('and(eq(b.courseId, courseId), eq(b.status, "SICK_LEAVE"), eq(b.plannedAtCreation, true), ne(b.id, rowId))');
  });
  test("both doors ask it before `addLeaveWeek` (door 1 and door 2), by source", () => {
    const S = read("src/services/scheduler.service.ts");
    expect(S).toContain('if (declaredFree && current.courseId && (await declarationTakesNewWeek(tx, current.courseId, id, current.date))) await addLeaveWeek(tx, current.courseId, "T1_PRE_START_DECLARATION");');
    expect(S).toContain('if (declaredFree && (await declarationTakesNewWeek(tx, courseId, b.id, b.date))) await addLeaveWeek(tx, courseId, "T1_PRE_START_DECLARATION");');
  });
});
