// 🔻 TASK-971 (REQ-5016 AC5, SPEC-109 §3.4) — the PURE planner of "change the pattern mid-course": the untaught rows (live, `fromDate` or later) are re-placed IN ORDER onto the new weekly pattern, the count kept, each row on its slot's own coach and time;
// taught / delivered / cancelled rows stay. Plus the shape rules (`patternProblem(p, 1)`), the apply order (no row lands on a slot a sibling still holds) and what `course_slots` holds afterwards.
import { describe, expect, test } from "bun:test";
import { isPatternChangeRefusal, planPatternChange, slotsToStore } from "./pattern-change";
import { expandPattern, patternProblem } from "./course-pattern";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const START = "2026-11-02"; // a Monday
const TODAY = "2026-11-13";
const row = (id: string, date: string, status: string, o: Record<string, unknown> = {}) => ({ id, date, startTime: "10:00:00", endTime: "11:00:00", status, teacherId: A, bookingType: "COURSE_PACKAGE", ...o });
const ROWS = [
  row("a1", "2026-11-02", "ATTENDED"), row("a2", "2026-11-09", "ATTENDED"), row("n1", "2026-11-10", "NO_SHOW"), row("l1", "2026-11-11", "SICK_LEAVE"),
  row("p1", "2026-11-16", "CONFIRMED"), row("p2", "2026-11-23", "PENDING"), row("p3", "2026-11-30", "EXTENDED"), row("p4", "2026-12-07", "PENDING"),
  row("c1", "2026-12-14", "CANCELLED"),
];
const TUE_B = { weekday: 2, startTime: "10:00", teacherId: B }, THU_A = { weekday: 4, startTime: "11:00", teacherId: A };
const plan = (pattern: any[], fromDate = "2026-11-16", rows: any[] = ROWS) => planPatternChange(rows, { startDate: START, fromDate, pattern }, TODAY);

describe("🔴 TASK-971 — the rows: only the untaught ones move; the count is kept; order and coaches per slot", () => {
  test("taught / no-show / leave / cancelled rows are NEVER moved; the 4 untaught rows are", () => {
    const p = plan([TUE_B, THU_A]);
    expect(isPatternChangeRefusal(p)).toBe(false);
    if (isPatternChangeRefusal(p)) return;
    expect(p.moves.map((m) => m.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(p.n).toBe(4);
  });
  test("they are re-placed IN ORDER onto the pattern from `fromDate` (Tue B 10:00, Thu A 11:00), each on its slot's OWN coach and time", () => {
    const p = plan([TUE_B, THU_A]);
    if (isPatternChangeRefusal(p)) throw new Error("refused");
    expect(p.moves.map((m) => [m.to.date, m.to.startTime, m.to.teacherId])).toEqual([["2026-11-17", "10:00", B], ["2026-11-19", "11:00", A], ["2026-11-24", "10:00", B], ["2026-11-26", "11:00", A]]);
    expect([p.firstDate, p.lastDate]).toEqual(["2026-11-17", "2026-11-26"]);
    expect(p.moves.map((m) => m.to.date)).toEqual(expandPattern(START, [TUE_B, THU_A], 4, new Set(), "2026-11-16").map((r) => r.date)); // THE seam: one expansion, no second scheduler
  });
  test("`fromDate` later in the course leaves the earlier untaught rows where they are (only rows on / after it move; the count is THAT many)", () => {
    const p = plan([TUE_B, THU_A], "2026-11-24");
    if (isPatternChangeRefusal(p)) throw new Error("refused");
    expect(p.moves.map((m) => m.id)).toEqual(["p3", "p4"]);
    expect(p.moves.map((m) => m.to.date)).toEqual(["2026-11-24", "2026-11-26"]);
  });
  test("a CONFIRMED row goes back to PENDING (its confirmation was of the old slot); every other live status is kept; `needsReconfirm` says how many", () => {
    const p = plan([TUE_B, THU_A]);
    if (isPatternChangeRefusal(p)) throw new Error("refused");
    expect(p.moves.map((m) => [m.status, m.toStatus])).toEqual([["CONFIRMED", "PENDING"], ["PENDING", "PENDING"], ["EXTENDED", "EXTENDED"], ["PENDING", "PENDING"]]);
    expect(p.needsReconfirm).toBe(1);
  });
  test("`teacherChanges` is true only when some row's coach changes", () => {
    expect((plan([TUE_B, THU_A]) as any).teacherChanges).toBe(true);
    expect((plan([{ weekday: 1, startTime: "10:00", teacherId: A }]) as any).teacherChanges).toBe(false);
  });
});

describe("🔴 TASK-971 — the refusals, each a code (nothing planned)", () => {
  test("PATTERN_INVALID (400): 0 slots, 22 slots, a duplicate (weekday, time), a quarter hour — the ONE `patternProblem(p, 1)`", () => {
    expect(plan([])).toMatchObject({ code: "PATTERN_INVALID", status: 400 });
    expect(plan(Array.from({ length: 22 }, (_, i) => ({ weekday: i % 7, startTime: `${String(8 + Math.floor(i / 7)).padStart(2, "0")}:00`, teacherId: A })))).toMatchObject({ code: "PATTERN_INVALID" });
    expect(plan([TUE_B, TUE_B])).toMatchObject({ code: "PATTERN_INVALID" });
    expect(plan([{ ...TUE_B, startTime: "10:15" }])).toMatchObject({ code: "PATTERN_INVALID" });
    expect(patternProblem([TUE_B], 1)).toBeNull(); // a ONE-slot result is legal HERE (a sale needs 2…21)
    expect(patternProblem([TUE_B], 2)).not.toBeNull();
  });
  test("START_IN_PAST (400) · NOTHING_TO_MOVE (409)", () => {
    expect(plan([TUE_B], "2026-11-12")).toMatchObject({ code: "START_IN_PAST", status: 400 });
    expect(plan([TUE_B], "2026-11-16", ROWS.filter((r) => r.status === "ATTENDED"))).toMatchObject({ code: "NOTHING_TO_MOVE", status: 409 });
    expect(plan([TUE_B], "2027-01-04")).toMatchObject({ code: "NOTHING_TO_MOVE", status: 409 }); // no untaught row on or after that date
  });
});

describe("🔴 TASK-971 — the apply order: no row lands on a slot a sibling that has not yet left still holds", () => {
  test("p2 moves ONTO p3's old slot (same coach, date, hour) ⇒ p3 is written BEFORE p2", () => {
    const rows = [row("x1", "2026-11-16", "PENDING"), row("x2", "2026-11-23", "PENDING")];
    // the new pattern is ONE Monday-10:00 slot starting 2026-11-23: x1 → 11-23 (x2's old slot), x2 → 11-30
    const p = planPatternChange(rows, { startDate: START, fromDate: "2026-11-16", pattern: [{ weekday: 1, startTime: "10:00", teacherId: A }] }, TODAY);
    if (isPatternChangeRefusal(p)) throw new Error("refused");
    const target = new Map(p.moves.map((m) => [m.id, m.to.date]));
    expect(target.get("x1")).toBe("2026-11-16"); // already on the pattern: it stays
    const q = planPatternChange([row("y1", "2026-11-16", "PENDING"), row("y2", "2026-11-23", "PENDING")], { startDate: START, fromDate: "2026-11-16", pattern: [{ weekday: 1, startTime: "10:00", teacherId: A }, { weekday: 3, startTime: "10:00", teacherId: A }] }, TODAY);
    if (isPatternChangeRefusal(q)) throw new Error("refused");
    const dest = new Map(q.moves.map((m) => [m.id, m.to.date]));
    const holder = new Map(q.moves.map((m) => [`${m.from.teacherId}|${m.from.date}|${m.from.startTime.slice(0, 5)}`, m.id]));
    const seen = new Set<string>();
    for (const id of q.order) {
      const m = q.moves.find((x) => x.id === id)!;
      const h = holder.get(`${m.to.teacherId}|${m.to.date}|${m.to.startTime.slice(0, 5)}`);
      if (h && h !== id) expect({ id, holderMovedFirst: seen.has(h) }).toEqual({ id, holderMovedFirst: true });
      seen.add(id);
    }
    expect(dest.size).toBe(2);
    expect([...q.order].sort()).toEqual(["y1", "y2"]);
  });
});

describe("🔒 TASK-971 — what `course_slots` holds afterwards", () => {
  test("2+ slots ⇒ the slots; a ONE-slot result ⇒ none (the course's own weekday / start_time carry it)", () => {
    expect(slotsToStore([TUE_B, THU_A])).toEqual([TUE_B, THU_A]);
    expect(slotsToStore([TUE_B])).toBeNull();
  });
});
