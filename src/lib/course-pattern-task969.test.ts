// TASK-969 (REQ-5016 F1, SPEC-109) — a course's WEEKLY PATTERN of hour-slots (Team C slice): the pure module, the create / preview expansion, the next-free-slot make-up (BOTH make-up writers),
// the DTO, the migration — and, above all, AC7: a ONE-slot course runs today's paths byte for byte.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { bookings, closedDays, teacherLeaveDays, teachers } from "../db/schema";
import * as sched from "../services/scheduler.service";
import { toCourseWithStudent } from "../db/mappers";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { createCoursePackage as createBody, previewCourse as previewBody } from "../validation";
import {
  MAX_PATTERN_SLOTS, courseWeekOf, expandPattern, hhmmOf, isPattern, nextFreeSlot, occurrencesAfter, orderPattern, patternProblem, slotDateInWeek, type Slot,
} from "./course-pattern";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/\/\/[^\n]*/g, "");
const dialect = new PgDialect();
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });
const NOW = "2026-11-13T10:00:00+07:00"; // Bangkok Friday 13 Nov 2026
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MON = "2026-11-16"; // a Monday

describe("the pure module — order, weeks, expansion", () => {
  test("a pattern is a pattern from 2 slots; ONE slot (or none, or `slots` not loaded) is a one-slot course", () => {
    expect([isPattern(null), isPattern(undefined), isPattern([]), isPattern([1]), isPattern([1, 2])]).toEqual([false, false, false, false, true]);
  });
  test("order = the weekday counted from the COURSE'S START weekday, then time: a Thursday start goes Thu, Sun, Mon", () => {
    const slots = [{ weekday: 1, startTime: "10:00" }, { weekday: 0, startTime: "09:00" }, { weekday: 4, startTime: "12:00" }, { weekday: 4, startTime: "11:00" }];
    expect(orderPattern("2026-11-19", slots).map((s) => `${s.weekday}@${s.startTime}`)).toEqual(["4@11:00", "4@12:00", "0@09:00", "1@10:00"]); // 2026-11-19 is a Thursday
    expect(orderPattern(MON, slots).map((s) => `${s.weekday}@${s.startTime}`)).toEqual(["1@10:00", "4@11:00", "4@12:00", "0@09:00"]);
  });
  test("a course week k = [start + 7(k−1), start + 7k − 1]; `slotDateInWeek` and `courseWeekOf` are inverse", () => {
    expect([courseWeekOf(MON, "2026-11-16"), courseWeekOf(MON, "2026-11-22"), courseWeekOf(MON, "2026-11-23"), courseWeekOf(MON, "2026-12-07")]).toEqual([1, 1, 2, 4]);
    expect(slotDateInWeek(MON, { weekday: 4 }, 2)).toBe("2026-11-26");
    expect(courseWeekOf(MON, slotDateInWeek(MON, { weekday: 0 }, 3))).toBe(3);
  });
  const mon_thu = (t: string, who = A): Slot[] => [1, 2, 3, 4].map((weekday) => ({ weekday, startTime: t, teacherId: who }));
  test("10 classes on Mon–Thu → 4 · 4 · 2 (the last week is partial), in date order, each with its slot's coach and time", () => {
    const rows = expandPattern(MON, mon_thu("10:00"), 10);
    expect(rows).toHaveLength(10);
    expect([1, 2, 3].map((w) => rows.filter((r) => r.week === w).length)).toEqual([4, 4, 2]);
    expect(rows.map((r) => r.date)).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-30", "2026-12-01"]);
    expect([...rows.map((r) => r.date)].sort()).toEqual(rows.map((r) => r.date)); // chronological
  });
  test("a MIXED-COACH day: two hours in one day, each its own coach, in time order; a Sunday start still lays out chronologically", () => {
    const slots: Slot[] = [{ weekday: 1, startTime: "11:00", teacherId: B }, { weekday: 1, startTime: "10:00", teacherId: A }, { weekday: 4, startTime: "12:00", teacherId: A }];
    const rows = expandPattern(MON, slots, 6);
    expect(rows.map((r) => [r.date, r.startTime, r.teacherId === A ? "A" : "B"])).toEqual([
      ["2026-11-16", "10:00", "A"], ["2026-11-16", "11:00", "B"], ["2026-11-19", "12:00", "A"],
      ["2026-11-23", "10:00", "A"], ["2026-11-23", "11:00", "B"], ["2026-11-26", "12:00", "A"],
    ]);
    const sun = expandPattern("2026-11-15", slots, 4); // a Sunday start: Mon, Mon, Thu, (next week) Mon
    expect(sun.map((r) => r.date)).toEqual(["2026-11-16", "2026-11-16", "2026-11-19", "2026-11-23"]);
  });
  test("`absentWeeks` are COURSE weeks: EVERY slot of such a week is born a planned absence", () => {
    const rows = expandPattern(MON, mon_thu("10:00"), 10, new Set([2]));
    expect(rows.filter((r) => r.absent).map((r) => r.date)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"]);
    expect(rows.filter((r) => !r.absent && r.week === 2)).toEqual([]);
  });
  test("§8b — `fromDate` (the 5th parameter): rows before it are skipped, `size` counts rows FROM it, `week` stays the course week; omitted = unchanged", () => {
    const all = expandPattern(MON, mon_thu("10:00"), 10);
    expect(expandPattern(MON, mon_thu("10:00"), 10, new Set(), MON)).toEqual(all); // an explicit default = no change
    const from = expandPattern(MON, mon_thu("10:00"), 5, new Set(), "2026-11-25"); // a Wednesday of week 2
    expect(from.map((r) => [r.date, r.week])).toEqual([["2026-11-25", 2], ["2026-11-26", 2], ["2026-11-30", 3], ["2026-12-01", 3], ["2026-12-02", 3]]);
    expect(from).toHaveLength(5);
    expect(expandPattern(MON, mon_thu("10:00"), 3, new Set([3]), "2026-11-26").map((r) => [r.date, r.absent])).toEqual([["2026-11-26", false], ["2026-11-30", true], ["2026-12-01", true]]);
  });
  test("the pattern's shape problems, in words: 2…21 slots, unique (weekday, startTime), weekday 0–6, a half-hour start; a change allows 1", () => {
    const ok: Slot[] = [{ weekday: 1, startTime: "10:00", teacherId: A }, { weekday: 4, startTime: "10:30", teacherId: A }];
    expect(patternProblem(ok)).toBeNull();
    expect(patternProblem([ok[0]!])).not.toBeNull(); // 1 slot at sale
    expect(patternProblem([ok[0]!], 1)).toBeNull(); // 1 slot is fine for a mid-course change
    expect(patternProblem(Array.from({ length: MAX_PATTERN_SLOTS + 1 }, (_, i) => ({ weekday: i % 7, startTime: `${String(8 + Math.floor(i / 7)).padStart(2, "0")}:00`, teacherId: A })))).not.toBeNull();
    expect(patternProblem(Array.from({ length: MAX_PATTERN_SLOTS }, (_, i) => ({ weekday: i % 7, startTime: `${String(8 + Math.floor(i / 7)).padStart(2, "0")}:00`, teacherId: A })))).toBeNull(); // exactly 21 fits
    expect(patternProblem([ok[0]!, { ...ok[0]! }])).not.toBeNull(); // the same (weekday, time)
    expect(patternProblem([ok[0]!, { ...ok[0]!, teacherId: B }])).not.toBeNull(); // …even with another coach
    expect(patternProblem([ok[0]!, { ...ok[1]!, startTime: "10:15" }])).not.toBeNull();
    expect(patternProblem([ok[0]!, { ...ok[1]!, weekday: 7 }])).not.toBeNull();
    expect(patternProblem([ok[0]!, { ...ok[0]!, startTime: "10:00:00" }])).not.toBeNull(); // HH:MM:SS reads as the same slot
  });
  test("`nextFreeSlot`: the first free occurrence AFTER the last planned row, in pattern order; `null` when nothing is free in 26 weeks; `hhmmOf` trims seconds", async () => {
    const slots = mon_thu("10:00").slice(0, 2).concat([{ weekday: 4, startTime: "10:00", teacherId: B }]).filter((s) => s.weekday !== 2); // Mon A, Thu B
    const free = async (busy: string[]) => nextFreeSlot(MON, slots, { date: "2026-11-19", startTime: "10:00" }, (o) => !busy.includes(o.date));
    expect((await free([]))?.date).toBe("2026-11-23"); // Mon — the NEXT slot, not Thursday + 7
    expect((await free(["2026-11-23"]))).toMatchObject({ date: "2026-11-26", teacherId: B }); // Monday busy ⇒ Thursday, with Thursday's own coach
    expect(await nextFreeSlot(MON, slots, { date: "2026-11-19", startTime: "10:00" }, () => false)).toBeNull();
    expect([...occurrencesAfter(MON, slots, "2026-11-16", "10:00", 1)].length).toBe(3); // weeks 1–2: Thu(w1), Mon(w2), Thu(w2) — bounded by `weeks`
    expect(hhmmOf("10:00:00")).toBe("10:00");
  });
});

// ─────────────────────────── the make-up: the next free slot ───────────────────────────
type Row = { id: string; status: string; date: string; startTime: string; teacherId: string; extendedFromId?: string | null; isMakeup?: boolean };
/** A tx for `reconcileCoursePlan`: reads the course + its rows, answers the three availability reads, and CAPTURES every insert. The course row carries `slots` as the real read's relation does. */
function world(o: { slots?: Array<{ ord: number; weekday: number; startTime: string; teacherId: string }>; rows: Row[]; busy?: Array<[string, string, string]>; leave?: Array<[string, string, string?, string?]>; closed?: string[]; hours?: Record<string, any> }) {
  const inserted: any[] = [];
  const paramsOf = (cond: any) => dialect.sqlToQuery(cond).params as unknown[];
  const dates = (cond: any) => paramsOf(cond).filter((p) => typeof p === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p)) as string[];
  const course = { id: "c1", studentId: "s1", size: 4, startDate: MON, priorSessions: 0, endedAt: null, droppedAt: null, expiryDate: "2027-06-01", slots: o.slots ?? [] };
  const tx: any = {
    query: {
      coursePackages: { findFirst: async () => course },
      bookings: {
        findMany: async () => o.rows.map((r) => ({ studentId: "s1", coStudentId: null, subjectId: "sub", endTime: r.startTime, bookingType: "COURSE_PACKAGE", courseId: "c1", groupId: null, plannedAtCreation: false, leaveCharged: false, isMakeup: false, extendedFromId: null, ...r })),
        findFirst: async (q: any) => {
          if (q.with) return undefined; // the make-up's confirm read: "refused" — it never fails the leave
          const ps = paramsOf(q.where(bookings, { and, eq, notInArray }));
          const hit = (o.busy ?? []).some(([t, d, st]) => ps.includes(t) && ps.includes(d) && ps.includes(st));
          return hit ? { id: "held" } : undefined;
        },
      },
      closedDays: { findFirst: async (q: any) => { const d = dates(q.where(closedDays, { and, eq, isNull }))[0]; return d && (o.closed ?? []).includes(d) ? { date: d, reason: "HOLIDAY" } : undefined; } },
      teacherLeaveDays: { findFirst: async (q: any) => { const ps = paramsOf(q.where(teacherLeaveDays, { and, eq })); const hit = (o.leave ?? []).find(([t, d]) => ps.includes(t) && ps.includes(d)); return hit ? { id: "l", startTime: hit[2] ?? null, endTime: hit[3] ?? null } : undefined; } },
      teachers: { findFirst: async (q: any) => ({ id: "t", workHours: null, ...(o.hours ?? {}) }) },
    },
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    insert: () => ({ values: (v: any) => { inserted.push(v); return { returning: async () => [{ id: `ext-${inserted.length}` }] }; } }),
    select: () => ({ from: () => ({ innerJoin: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [] }) }) }) }) }),
  };
  return { tx, inserted, course };
}
const r = (id: string, status: string, date: string, startTime: string, teacherId = A, extra: Partial<Row> = {}): Row => ({ id, status, date, startTime, teacherId, ...extra });
// A 4-class Mon/Thu pattern course: Mon 16 ✔, Thu 19 on LEAVE, Mon 23 ✔, Thu 26 ✔ — its make-up is owed after the last planned row (Thu 26)
const MONTHU = [{ ord: 0, weekday: 1, startTime: "10:00:00", teacherId: A }, { ord: 1, weekday: 4, startTime: "11:00:00", teacherId: B }];
const PLAN: Row[] = [r("r1", "CONFIRMED", "2026-11-16", "10:00:00"), r("L", "SICK_LEAVE", "2026-11-19", "11:00:00", B), r("r3", "CONFIRMED", "2026-11-23", "10:00:00"), r("r4", "CONFIRMED", "2026-11-26", "11:00:00", B)];

describe("SPEC §3.2 — the make-up of a PATTERN course goes to the NEXT FREE SLOT in pattern order (the reconcile writer)", () => {
  test("Thu missed: the make-up lands on the NEXT slot after the last planned row — Monday 30 Nov 10:00 with MONDAY's coach (not Thursday + 7, not the template's)", async () => {
    setSystemTime(new Date(NOW));
    const w = world({ slots: MONTHU, rows: PLAN });
    const out = await sched.reconcileCoursePlan(w.tx, "c1");
    expect(out.appended).toHaveLength(1);
    expect(w.inserted[0]).toMatchObject({ date: "2026-11-30", startTime: "10:00", endTime: "11:00", teacherId: A, isMakeup: true, extendedFromId: "L", courseId: "c1", status: "EXTENDED" });
  });
  test("a BUSY next slot is skipped (the slot-holder predicate): Monday held ⇒ Thursday 3 Dec, with Thursday's coach and time", async () => {
    setSystemTime(new Date(NOW));
    const w = world({ slots: MONTHU, rows: PLAN, busy: [[A, "2026-11-30", "10:00"]] });
    await sched.reconcileCoursePlan(w.tx, "c1");
    expect(w.inserted[0]).toMatchObject({ date: "2026-12-03", startTime: "11:00", endTime: "12:00", teacherId: B });
  });
  test("…and so is a slot whose coach is ON LEAVE at that hour (a 10–12 window blocks 10:00), a CLOSED day, and an hour OUTSIDE the coach's working hours", async () => {
    setSystemTime(new Date(NOW));
    const leave = world({ slots: MONTHU, rows: PLAN, leave: [[A, "2026-11-30", "10:00", "12:00"]] });
    await sched.reconcileCoursePlan(leave.tx, "c1");
    expect(leave.inserted[0]).toMatchObject({ date: "2026-12-03" });
    const closed = world({ slots: MONTHU, rows: PLAN, closed: ["2026-11-30"] });
    await sched.reconcileCoursePlan(closed.tx, "c1");
    expect(closed.inserted[0]).toMatchObject({ date: "2026-12-03" });
    const hours = world({ slots: MONTHU, rows: PLAN, hours: { workHours: { "1": ["13:00", "18:00"] } } }); // Monday 10:00 is outside every coach's 13–18
    await sched.reconcileCoursePlan(hours.tx, "c1");
    expect(hours.inserted[0]).toMatchObject({ date: "2026-12-03" });
  });
  test("a 10–12 leave does NOT block a slot at 13:00 (only the blocked HOURS read as not free)", async () => {
    setSystemTime(new Date(NOW));
    const slots = [{ ord: 0, weekday: 1, startTime: "13:00:00", teacherId: A }, MONTHU[1]!];
    const w = world({ slots, rows: [r("r1", "CONFIRMED", "2026-11-16", "13:00:00"), PLAN[1]!, r("r3", "CONFIRMED", "2026-11-23", "13:00:00"), PLAN[3]!], leave: [[A, "2026-11-30", "10:00", "12:00"]] });
    await sched.reconcileCoursePlan(w.tx, "c1");
    expect(w.inserted[0]).toMatchObject({ date: "2026-11-30", startTime: "13:00" });
  });
  test("a make-up OF A MAKE-UP: the search runs after the last planned row each time (two leaves ⇒ two different slots, in order)", async () => {
    setSystemTime(new Date(NOW));
    const rows = [PLAN[0]!, PLAN[1]!, PLAN[2]!, r("L2", "SICK_LEAVE", "2026-11-26", "11:00:00", B)];
    const w = world({ slots: MONTHU, rows });
    await sched.reconcileCoursePlan(w.tx, "c1");
    expect(w.inserted.map((v) => [v.date, v.startTime])).toEqual([["2026-11-30", "10:00"], ["2026-12-03", "11:00"]]);
  });
  test("nothing free in 26 weeks ⇒ the existing exhausted-search rule: the make-up is STILL created (never refused) on the old weekly search from the last row", async () => {
    setSystemTime(new Date(NOW));
    const never = world({ slots: MONTHU, rows: PLAN, hours: { workHours: { "1": ["22:00", "23:00"], "4": ["22:00", "23:00"] } } }); // no slot ever fits the coach's hours
    await sched.reconcileCoursePlan(never.tx, "c1");
    expect(never.inserted).toHaveLength(1);
    expect(never.inserted[0]).toMatchObject({ teacherId: B, startTime: "11:00:00" }); // the TEMPLATE's coach and time (the leave row's), as for a one-slot course
  });
});

describe("AC7 — a ONE-slot course keeps `findFreeExtensionDate`, byte for byte", () => {
  test("no `course_slots` rows (or ONE) ⇒ the make-up is the old +7 from the last row, with the TEMPLATE's coach and time — and the pattern search is never asked", async () => {
    setSystemTime(new Date(NOW));
    const pick = spyOn(sched, "pickPatternMakeupSlot");
    spies.push(pick);
    for (const slots of [[], [{ ord: 0, weekday: 1, startTime: "10:00:00", teacherId: A }], undefined]) {
      const rows = [r("r1", "CONFIRMED", "2026-11-16", "10:00:00"), r("L", "SICK_LEAVE", "2026-11-23", "10:00:00"), r("r3", "CONFIRMED", "2026-11-30", "10:00:00"), r("r4", "CONFIRMED", "2026-12-07", "10:00:00")];
      const w = world({ slots, rows });
      await sched.reconcileCoursePlan(w.tx, "c1");
      expect(w.inserted[0]).toMatchObject({ date: "2026-12-14", startTime: "10:00:00", teacherId: A });
    }
    expect(pick).not.toHaveBeenCalled();
  });
  test("by source: the pattern branch is guarded by `patternOf(course).length` (≥ 2 rows) in BOTH make-up writers, and a one-slot course reaches the old line unchanged", () => {
    const S = code(read("src/services/scheduler.service.ts"));
    expect([...S.matchAll(/pickPatternMakeupSlot\(/g)].length).toBe(4); // the definition · the reconcile · the sick-leave door · the pattern preview
    expect(S).toContain("const patternSlotsOfCourse = placed ? [] : patternOf(course);");
    expect(S).toContain("const patternSlotsOfCourse = patternOf(current.course);");
    expect(S).toContain("const extDate: string = placed ? placed.date : slotPick ? slotPick.date : await findFreeExtensionDate(tx, template.teacherId, template.startTime, fromDate, coachOffDates);");
    expect(S).toContain("if (!slotPick && searchExhausted(fromDate, extDate)) {");
    expect(S).toContain("teacherId: slotPick ? slotPick.teacherId : template.teacherId,");
    expect(S).toContain("teacherId: slotPick ? slotPick.teacherId : current.teacherId,");
    // `findFreeExtensionDate` itself was not touched for the pattern: it is not given a slot list
    const ffed = S.slice(S.indexOf("export async function findFreeExtensionDate("));
    expect(ffed.slice(0, ffed.indexOf("\n}\n"))).not.toContain("slots");
    // `patternOf` is the ONE rule (≥ 2); the create branches on `isPattern(patternSlots)` — never on a count of its own
    expect(S).toContain("const patternRows = isPattern(patternSlots) ? markAbsentRows(expandPattern("); // 🔻 TASK-989 (D-164-1): the declared absences are ROW positions now
    expect(S).toContain("if (input.pattern?.length && isPattern(input.pattern)) return previewPatternCourse(");
  });
  test("`patternOf`: pattern order by `ord`, `HH:MM`; empty for 0 / 1 rows and for a course whose `slots` were not loaded", () => {
    expect(sched.patternOf({ startDate: MON, slots: [{ ord: 1, weekday: 4, startTime: "11:00:00", teacherId: B }, { ord: 0, weekday: 1, startTime: "10:00:00", teacherId: A }] })).toEqual([{ weekday: 1, startTime: "10:00", teacherId: A }, { weekday: 4, startTime: "11:00", teacherId: B }]);
    expect(sched.patternOf({ startDate: MON, slots: [{ ord: 0, weekday: 1, startTime: "10:00:00", teacherId: A }] })).toEqual([]);
    expect(sched.patternOf({ startDate: MON })).toEqual([]);
    expect(sched.patternOf(null)).toEqual([]);
  });
});

describe("the sick-leave door's OWN make-up (the second writer) branches the same way", () => {
  test("by source: the door reads the course with its `slots`, asks the pattern search from the latest (date, time), and writes the slot's coach and time", () => {
    const S = code(read("src/services/scheduler.service.ts"));
    expect(S).toContain("with: { course: { with: { slots: true } }, voucher: true },");
    expect(S).toContain("orderBy: (b, { desc }) => [desc(b.date), desc(b.startTime)],");
    expect(S).toContain("await pickPatternMakeupSlot(tx, current.course!.startDate, patternSlotsOfCourse, { date: lastDate, startTime: latest[0]?.startTime ?? current.startTime })");
    expect(S).toContain("startTime: slotPick ? slotPick.startTime : current.startTime,");
    expect(S).toContain("endTime: slotPick ? addHour(slotPick.startTime) : current.endTime,");
  });
});

// ─────────────────────────── create / preview / DTO ───────────────────────────
describe("SPEC §4 — the bodies: `pattern` on the create and the preview", () => {
  const base = { student: { id: A }, teacherId: A, subjectId: B, size: 10, startDate: MON, startTime: "10:00" } as const;
  const slots = [{ weekday: 1, startTime: "10:00", teacherId: A }, { weekday: 4, startTime: "11:00", teacherId: B }];
  const ok = (b: unknown) => createBody.safeParse(b);
  test("2…21 unique slots are accepted; the body without a pattern is parsed exactly as before", () => {
    expect(ok({ ...base, pattern: slots }).success).toBe(true);
    expect((ok(base) as any).success).toBe(true);
    expect((ok(base) as any).data).not.toHaveProperty("pattern");
  });
  test("refusals (400 VALIDATION): 1 slot, 22 slots, a duplicate (weekday, time), a quarter hour, `pattern` with `sessions` or with `groupKey`, an absent week beyond the drawn plan", () => {
    expect(ok({ ...base, pattern: [slots[0]] }).success).toBe(false);
    expect(ok({ ...base, pattern: Array.from({ length: 22 }, (_, i) => ({ weekday: i % 7, startTime: "10:00", teacherId: A })) }).success).toBe(false);
    expect(ok({ ...base, pattern: [slots[0], slots[0]] }).success).toBe(false);
    expect(ok({ ...base, pattern: [slots[0], { ...slots[1], startTime: "11:15" }] }).success).toBe(false);
    expect(ok({ ...base, pattern: slots, sessions: Array.from({ length: 10 }, (_, i) => ({ date: `2026-11-${String(16 + i).padStart(2, "0")}` })) }).success).toBe(false);
    expect(ok({ ...base, pattern: slots, groupKey: "11111111-1111-4111-8111-111111111111" }).success).toBe(false);
    expect(ok({ ...base, pattern: slots, absentWeeks: [10] }).success).toBe(true); // 🔻 TASK-989 (D-164-1): ROW positions — the 10th planned row
    expect(ok({ ...base, pattern: slots, absentWeeks: [11] }).success).toBe(false); // row 11 is not a planned row
  });
  test("the preview takes the same `pattern` (and the same refusals); without it the body is today's", () => {
    const p = (b: unknown) => previewBody.safeParse(b);
    const pb = { teacherId: A, subjectId: B, size: 10, startDate: MON, startTime: "10:00" };
    expect(p({ ...pb, pattern: slots }).success).toBe(true);
    expect(p(pb).success).toBe(true);
    expect(p({ ...pb, pattern: [slots[0], slots[0]] }).success).toBe(false);
    expect(p({ ...pb, pattern: slots, absentWeeks: [11] }).success).toBe(false); // 🔻 TASK-989
  });
});

describe("SPEC §3.1 — the PREVIEW of a pattern course is the SAME expansion the create runs, each row with its own coach and time", () => {
  const arm = (busy: Array<[string, string, string]> = []) => {
    const { db } = require("../db");
    spies.push(spyOn(db.query.subjects, "findFirst").mockImplementation((async () => ({ id: B, name: "Skate" })) as any));
    spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async (q: any) => ({ id: dialect.sqlToQuery(q.where(teachers, { eq })).params[0] as string, nickname: "Coach", name: "Coach", workHours: null })) as any));
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async (q: any) => {
      const ps = dialect.sqlToQuery(q.where(bookings, { and, eq, notInArray })).params as unknown[];
      return busy.some(([t, d, st]) => ps.includes(t) && ps.includes(d) && ps.includes(st)) ? { id: "held" } : undefined;
    }) as any));
    spies.push(spyOn(db.query.closedDays, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db.query.teacherLeaveDays, "findFirst").mockImplementation((async () => undefined) as any));
  };
  const input = { teacherId: A, subjectId: B, size: 4, startDate: MON, startTime: "10:00", pattern: [{ weekday: 1, startTime: "10:00", teacherId: A }, { weekday: 4, startTime: "11:00", teacherId: B }] };
  test("size 4 on Mon 10:00 (A) + Thu 11:00 (B): four dated rows, each its slot's time; the start time is the FIRST slot's", async () => {
    setSystemTime(new Date(NOW)); arm();
    const out: any = await sched.previewCoursePackage(input as any);
    expect(out.sessions.map((s: any) => [s.date, s.startTime, s.absent, s.makeup])).toEqual([["2026-11-16", "10:00", false, false], ["2026-11-19", "11:00", false, false], ["2026-11-23", "10:00", false, false], ["2026-11-26", "11:00", false, false]]);
    expect(out).toMatchObject({ size: 4, startDate: MON, startTime: "10:00", liveCount: 4, endDate: "2026-11-26" });
    expect(out.sessions.map((s: any) => s.teacher?.id)).toEqual([A, B, A, B]);
  });
  test("🔻 TASK-989: declared absent ROWS (3 and 4 = Mon 23, Thu 26): each is an absence, and each earns a make-up at the next free slot (a busy Monday is skipped); live count stays `size`", async () => {
    setSystemTime(new Date(NOW)); arm([[A, "2026-11-30", "10:00"]]);
    const out: any = await sched.previewCoursePackage({ ...input, absentWeeks: [3, 4] } as any);
    expect(out.sessions.map((s: any) => [s.date, s.startTime, s.absent ? "absent" : s.makeup ? "makeup" : "plan"])).toEqual([
      ["2026-11-16", "10:00", "plan"], ["2026-11-19", "11:00", "plan"], ["2026-11-23", "10:00", "absent"], ["2026-11-26", "11:00", "absent"],
      ["2026-12-03", "11:00", "makeup"], ["2026-12-07", "10:00", "makeup"], // Mon 30 Nov is held ⇒ Thu 3 Dec, then Mon 7 Dec
    ]);
    expect(out.liveCount).toBe(4);
    expect(out.endDate).toBe("2026-12-07");
  });
  test("a ONE-slot body (no pattern, or a one-slot `pattern`) takes today's preview: the weekly chain from the body's own teacher and time", async () => {
    setSystemTime(new Date(NOW)); arm();
    const out: any = await sched.previewCoursePackage({ ...input, pattern: undefined } as any);
    expect(out.sessions.map((s: any) => s.date)).toEqual(["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"]);
    const one: any = await sched.previewCoursePackage({ ...input, pattern: [input.pattern[0]] } as any);
    expect(one.sessions.map((s: any) => s.date)).toEqual(["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"]);
  });
});

describe("the DTO — `slots`", () => {
  test("a pattern course reads its slots in pattern order as HH:MM; a one-slot course (no rows, or `slots` not loaded) reads null", () => {
    const row = { id: "c", size: 10, startDate: MON, leaveUsed: 0, student: { id: "s", name: "Ploy", nickname: "Ploy" } };
    const dto = (c: any) => (toCourseWithStudent(c) as any).slots;
    expect(dto({ ...row, slots: [{ ord: 1, weekday: 4, startTime: "11:00:00", teacherId: B }, { ord: 0, weekday: 1, startTime: "10:00:00", teacherId: A }] })).toEqual([{ weekday: 1, startTime: "10:00", teacherId: A }, { weekday: 4, startTime: "11:00", teacherId: B }]);
    expect(dto({ ...row, slots: [] })).toBeNull();
    expect(dto({ ...row, slots: [{ ord: 0, weekday: 1, startTime: "10:00:00", teacherId: A }] })).toBeNull();
    expect(dto(row)).toBeNull();
  });
  test("by source: the list, the create's answer and the edit's answer load `slots`", () => {
    const S = read("src/services/scheduler.service.ts");
    expect(S).toContain("with: { student: true, coStudent: true, subject: true, slots: true, bookings: { with: { subject: true }, limit: 1 } },");
    expect(S).toContain("with: { student: true, coStudent: true, slots: true },\n    });\n    const created = await tx.query.bookings.findMany({");
  });
});

describe("`courseSlotsOf` (the seam to the mid-course change) and the create's storage", () => {
  test("by value: the rows by `ord` as HH:MM slots; null for 0 or 1 rows", async () => {
    const exec = (rows: any[]) => ({ query: { courseSlots: { findMany: async () => rows } } });
    expect(await sched.courseSlotsOf(exec([{ ord: 0, weekday: 1, startTime: "10:00:00", teacherId: A }, { ord: 1, weekday: 4, startTime: "11:30:00", teacherId: B }]), "c")).toEqual([{ weekday: 1, startTime: "10:00", teacherId: A }, { weekday: 4, startTime: "11:30", teacherId: B }]);
    expect(await sched.courseSlotsOf(exec([]), "c")).toBeNull();
    expect(await sched.courseSlotsOf(exec([{ ord: 0, weekday: 1, startTime: "10:00:00", teacherId: A }]), "c")).toBeNull();
  });
  test("by source: the create expands the pattern into the SAME per-row loop, stores `course_slots` (pattern order) BEFORE the rows, keeps the first slot's weekday / time on the course, and skips the make-up flip", () => {
    const S = code(read("src/services/scheduler.service.ts"));
    const create = S.slice(S.indexOf("export async function createCoursePackage("), S.indexOf("export async function createCoursePackage(") + 16000);
    expect(create).toContain('if (input.pattern?.length && (input.sessions?.length || input.groupKey)) throw badRequest(');
    expect(create).toContain("weekday: patternRows ? patternSlots[0]!.weekday : weekdayOf(input.startDate),");
    expect(create).toContain("startTime: patternRows ? patternSlots[0]!.startTime : input.startTime,");
    expect(create).toContain("if (patternRows) await tx.insert(courseSlots).values(patternSlots.map((s, ord) => ({ courseId: course.id, ord, weekday: s.weekday, startTime: s.startTime, teacherId: s.teacherId })));");
    expect(create.indexOf("await tx.insert(courseSlots)")).toBeLessThan(create.indexOf("for (const [i, s] of plannedSessions.entries())"));
    expect(create).toContain("const absent = patternRows ? patternRows[i]!.absent : absentWeeks.has(i + 1);");
    expect(create).toContain("const wanted = patternRows ? 0 :");
    // the rows meet `insertBooking` (clash · closed day · leave · hours) exactly as single classes do: nothing is inserted around it
    expect(create).toContain("await insertBooking(tx, studentId, {");
    expect(create).toContain("teacherId: s.teacherId,");
    expect(create).toContain("startTime: s.startTime,");
  });
});

describe("SPEC §3.5 / Q1 — the LINE course-confirm message: a PATTERN course loses the weekly line (dates only) until the owner approves the new wording", () => {
  test("by source: the weekly line's three fields are dropped for 2+ slots ONLY, AFTER the payload is built whole (a one-slot course keeps every field, byte for byte); the course is read with its slots", () => {
    const S = code(read("src/services/scheduler.service.ts"));
    expect(S).toContain('if (isPattern(course.slots)) for (const k of ["weekday", "startTime", "endTime"]) delete (coursePayload as any)[k];');
    expect(S).toContain("weekday: course.weekday,\n      startTime: hhmm(course.startTime),");
    expect(S).toContain("endTime: addHour(course.startTime),");
    const load = S.slice(S.indexOf("async function loadCourseForEnd("));
    expect(load.slice(0, load.indexOf("\n}\n"))).toContain("with: { slots: true },");
    // the dates the message already carries are untouched: the planned-leave and make-up date lists
    expect(S).toContain("...(makeupDates.length ? { makeupDates } : {}),");
    expect(S).toContain("plannedLeaveDates: rows");
  });
  test("by value: the drop is exactly those three keys — what stays is the dates, the count, the coach, the program", () => {
    const payload: any = { kind: "course_confirmed", startDate: MON, weekday: 1, startTime: "10:00", endTime: "11:00", size: 10, coach: "Ek", plannedLeaveDates: ["2026-11-23"], makeupDates: ["2026-12-14"] };
    const slots = [{ ord: 0 }, { ord: 1 }];
    if (isPattern(slots)) for (const k of ["weekday", "startTime", "endTime"]) delete payload[k];
    expect(payload).toEqual({ kind: "course_confirmed", startDate: MON, size: 10, coach: "Ek", plannedLeaveDates: ["2026-11-23"], makeupDates: ["2026-12-14"] });
  });
});

describe("the migration 0081 — a NEW EMPTY table, no backfill, witnessed by the LAST object", () => {
  const SQL = read("drizzle/0081_course_slots.sql");
  const body = SQL.replace(/^--.*$/gm, "");
  test("the text: the table (CASCADE on the course, RESTRICT on the coach, weekday CHECK), the unique (course, ord) index LAST; nothing destructive, nothing written", () => {
    expect(body).toContain('CREATE TABLE IF NOT EXISTS "course_slots"');
    expect(body).toContain('"course_id" uuid NOT NULL REFERENCES "course_packages"("id") ON DELETE CASCADE');
    expect(body).toContain('"teacher_id" uuid NOT NULL REFERENCES "teachers"("id") ON DELETE RESTRICT');
    expect(body).toContain('"weekday" smallint NOT NULL CHECK ("weekday" BETWEEN 0 AND 6)');
    const stmts = SQL.split("--> statement-breakpoint").map((x) => x.replace(/^--.*$/gm, "").trim()).filter(Boolean);
    expect(stmts[stmts.length - 1]).toBe('CREATE UNIQUE INDEX IF NOT EXISTS "course_slots_course_ord_uq" ON "course_slots" ("course_id", "ord");');
    expect(body).not.toMatch(/DROP |DELETE FROM|TRUNCATE|UPDATE |INSERT INTO|ALTER TABLE/i);
  });
  test("the journal: idx 81, the tag, a `when` UNIQUE and the highest; the witness probes the unique index", () => {
    const j = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const last = j.entries[j.entries.length - 1]!;
    expect(last).toMatchObject({ idx: 81, tag: "0081_course_slots" });
    const whens = j.entries.map((e) => e.when);
    expect(new Set(whens).size).toBe(whens.length);
    expect(last.when).toBe(Math.max(...whens));
    expect(SCHEDULING_WITNESSES.find((w) => w.tag === "0081_course_slots")).toMatchObject({ probe: { kind: "index", index: "course_slots_course_ord_uq" }, rerunnable: true });
  });
  test("the schema declares the table with the SAME names, and the course has the `slots` relation", () => {
    const schema = read("src/db/schema.ts");
    expect(schema).toContain('"course_slots",');
    expect(schema).toContain('courseId: uuid("course_id").notNull().references(() => coursePackages.id, { onDelete: "cascade" }),');
    expect(schema).toContain('teacherId: uuid("teacher_id").notNull().references(() => teachers.id, { onDelete: "restrict" }),');
    expect(schema).toContain('uniqueIndex("course_slots_course_ord_uq").on(t.courseId, t.ord)');
    expect(schema).toContain("slots: many(courseSlots),");
  });
  test("§8b: the seam Bob's act (TASK-971: whole-day leave, the quota doors, change-pattern, resume) reads through is exported: `courseSlotsOf`, and `expandPattern`'s 5th `fromDate`", () => {
    const S = read("src/services/scheduler.service.ts");
    expect(S).toContain("export async function courseSlotsOf(exec: any, courseId: string): Promise<Slot[] | null> {");
    expect(read("src/lib/course-pattern.ts")).toContain("export function expandPattern(startDate: string, slots: readonly Slot[], size: number, absentWeeks: ReadonlySet<number> = new Set(), fromDate: string = startDate): PatternRow[] {");
  });
});
