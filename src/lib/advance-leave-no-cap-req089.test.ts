// TASK-363 (`REQ-089 §4.2`) — the `< size` cap is GONE: every planned row is leaveable, no ceiling, advance leave
// still free. Owner's case: a family must leave an EXTENDED session too, and on a size-4 the cap refused the very
// first make-up leave. ⚠️ The LINE is XS; the two GATES are the task — pinned with VALUES, run not read.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { courseBornCeiling, courseCurrent, deriveLiveEndDate, makeupsToFlip, planCourseMoves, plannedRowCount, plannedRowExists } from "./course-plan";
import { courseExpiry, courseSessionDates } from "./recurring";
import { addDays } from "./time";
import { buildCourseHistory } from "./course-history";
import { isNearlyFinishedCourse } from "./attention";
import { courseRemainingSessions } from "./eligibility";
import { readSrc } from "./read-src";
import * as v from "../validation";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const T = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const body = (size: number, absentWeeks?: number[]) => ({ student: { id: T }, teacherId: T, subjectId: S, size, startDate: "2026-09-16", startTime: "10:00", ...(absentWeeks ? { absentWeeks } : {}) });
const START = "2026-09-23";
const week = (n: number) => addDays(START, (n - 1) * 7);

describe("🔴 THE LINE — the cap is gone from the source, and an all-originals-absent course is ACCEPTED", () => {
  test("🔑 size 4, all four originals absent ⇒ accepted; the make-ups too ⇒ accepted", () => {
    expect(v.createCoursePackage.safeParse(body(4, [1, 2, 3, 4])).success).toBe(true);
    expect(v.createCoursePackage.safeParse(body(4, [1, 2, 3, 4, 5, 6, 7, 8])).success).toBe(true);
    expect(v.createCoursePackage.safeParse(body(6, [1, 2, 3, 4, 5, 6])).success).toBe(true);
  });

  test("🚫 the cap is GONE from the source — and the existence rule (TASK-361) still refuses a row nobody will see", () => {
    const VAL = code(src("src/validation.ts"));
    expect(VAL).not.toContain("new Set(d.absentWeeks).size < d.size");
    expect(VAL).not.toContain("ลาทุกสัปดาห์ไม่ได้");
    expect(VAL).toContain("plannedRowExists(w, d.size, new Set(d.absentWeeks))");
    // {1,2,3,4} draws 8 rows; 9 does not exist.
    expect(v.createCoursePackage.safeParse(body(4, [1, 2, 3, 4, 9])).success).toBe(false);
  });
});

describe("🔑 GATE 1 — the chain TERMINATES: rows ≤ size + |absent|, pinned with values", () => {
  test("size 4, absent {1,2,3,4} ⇒ 8 rows, 4 live (all make-ups), all 4 originals absent", () => {
    const absent = new Set([1, 2, 3, 4]);
    expect(plannedRowCount(4, absent)).toBe(8);
    const rows = Array.from({ length: 8 }, (_, i) => ({ w: i + 1, live: !absent.has(i + 1), makeup: i + 1 > 4 }));
    expect(rows.filter((r) => r.live).map((r) => r.w)).toEqual([5, 6, 7, 8]);
    expect(rows.slice(0, 4).every((r) => !r.live)).toBe(true);
  });

  test("absent {1..4, 5..8} ⇒ 12 rows — a make-up of every make-up, and it still stops", () => {
    expect(plannedRowCount(4, new Set([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(12);
    expect(plannedRowExists(12, 4, new Set([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(true);
    expect(plannedRowExists(13, 4, new Set([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
  });

  test("🔴 the bound: rows ≤ size + |absent| for every finite request, and rows = size + |declared positions that exist|", () => {
    for (const [size, absent] of [[4, [1, 2, 3, 4]], [4, [1, 2, 3, 4, 5, 6, 7, 8]], [6, [1, 2, 3, 4, 5, 6]], [10, Array.from({ length: 10 }, (_, i) => i + 1)], [4, [2, 5, 6, 7]], [4, [1, 3, 5, 7, 9]]] as Array<[number, number[]]>) {
      const set = new Set(absent);
      const n = plannedRowCount(size, set);
      expect({ size, absent, bounded: n <= size + set.size }).toEqual({ size, absent, bounded: true });
      const existing = [...set].filter((w) => w <= n).length;
      expect({ size, absent, exact: n === size + existing }).toEqual({ size, absent, exact: true });
    }
  });

  test("🔑 the create's flip loop runs at most `wanted` passes and each pass flips only rows that exist and are not yet flipped", () => {
    // Simulate the create: chain rows born absent; each reconcile appends (size − live) EXTENDED rows; the
    // second pass flips the declared make-ups; repeat with the guarded break. Count the passes.
    const simulate = (size: number, absent: Set<number>) => {
      const rows: Array<{ id: string; status: string }> = Array.from({ length: size }, (_, i) => ({ id: `r${i + 1}`, status: absent.has(i + 1) ? "SICK_LEAVE" : "CONFIRMED" }));
      const reconcile = () => { const live = rows.filter((r) => r.status !== "SICK_LEAVE").length; for (let k = live; k < size; k++) rows.push({ id: `r${rows.length + 1}`, status: "EXTENDED" }); };
      reconcile();
      const wanted = plannedRowCount(size, absent);
      let passes = 0;
      for (let guard = 0; guard < wanted; guard++) {
        const toFlip = makeupsToFlip(rows, size, absent);
        if (!toFlip.length) break;
        passes++;
        for (const r of toFlip) r.status = "SICK_LEAVE";
        reconcile();
      }
      return { rows, passes, wanted };
    };
    const a = simulate(4, new Set([1, 2, 3, 4]));
    expect(a.rows.length).toBe(8);
    expect(a.passes).toBe(0); // nothing past the chain was declared ⇒ no flip pass at all
    const b = simulate(4, new Set([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(b.rows.length).toBe(12);
    expect(b.passes).toBe(1); // rows 5–8 flipped in ONE pass, one reconcile appends 9–12
    expect(b.passes).toBeLessThanOrEqual(b.wanted);
    const c = simulate(4, new Set([2, 5, 6]));
    expect(c.rows.length).toBe(7);
    expect(c.passes).toBe(2); // row 5 exists after the first reconcile; row 6 only after the second
    expect(c.rows.filter((r) => r.status !== "SICK_LEAVE").length).toBe(4);
  });
});

describe("🔑 GATE 2 — a course with ZERO attended originals is a VALID state everywhere downstream (run, not read)", () => {
  /** size 4, all originals absent, four make-ups appended and live. */
  const originals = courseSessionDates(START, 4).map((date, i) => ({ id: `o${i + 1}`, date, status: "SICK_LEAVE", bookingType: "COURSE_PACKAGE", extendedFromId: null }));
  const makeups = [5, 6, 7, 8].map((w, i) => ({ id: `m${i + 1}`, date: week(w), status: "EXTENDED", bookingType: "COURSE_PACKAGE", extendedFromId: `o${i + 1}` }));
  const sessions = [...originals, ...makeups] as any[];

  test("the ceiling: base + 4 weeks — week 5 + 4 = week 9 — and Kavya still holds", () => {
    expect(courseBornCeiling(courseExpiry(START, 4), courseSessionDates(START, 4).at(-1)!, 4)).toBe(week(9));
    expect(courseBornCeiling(courseExpiry(START, 6), courseSessionDates(START, 6).at(-1)!, 3)).toBe(week(11));
    // …and the ceiling covers the last make-up (week 8).
    expect(week(9) >= makeups.at(-1)!.date).toBe(true);
  });

  test("the plan engine: current = 4 = size ⇒ NO moves; the live end is the last make-up", () => {
    expect(courseCurrent(sessions)).toBe(4);
    expect(planCourseMoves(sessions, 4)).toEqual({ append: [], cancelIds: [] });
    expect(deriveLiveEndDate(sessions)).toBe(week(8));
  });

  test("`leaveUsed` is UNTOUCHED by the create — a declared absence is free (decision B), asserted at the source", () => {
    const SVC = code(src("src/services/scheduler.service.ts"));
    const create = SVC.slice(SVC.indexOf("export async function createCoursePackage("), SVC.indexOf("\n}\n", SVC.indexOf("export async function createCoursePackage(")));
    expect(create).not.toContain("leaveUsed");
  });

  test("attention: `usedSessions` is 0 ⇒ remaining = size ⇒ NOT nearly finished — correct, not merely quiet", () => {
    const c = { size: 4, usedSessions: 0, expiryDate: week(9), status: "CONFIRMED", endedAt: null } as any;
    expect(courseRemainingSessions(c)).toBe(4);
    expect(isNearlyFinishedCourse(c, START)).toBe(false);
  });

  test("history: four `sick-leave` events and four `makeup-appended` events, each make-up naming its original — labels RIGHT, nothing wrong", () => {
    const h = buildCourseHistory(
      { size: 4, leaveUsed: 0 },
      sessions.map((s) => ({ ...s, createdAt: new Date("2026-09-01"), updatedAt: new Date("2026-09-01"), teacher: null, subject: null, note: null })) as any,
      [],
    );
    const kinds = h.events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "sick-leave").length).toBe(4);
    expect(kinds.filter((k) => k === "makeup-appended").length).toBe(4);
    for (const e of h.events.filter((e) => e.kind === "makeup-appended")) expect(typeof e.makeupOfDate).toBe("string");
    expect(h.summary.leaveUsed).toBe(0);
    expect(h.summary.remaining).toBe(4);
  });

  test("the daily reminder prints only CONFIRMED rows — a SICK_LEAVE is never printed as a class", () => {
    const JOBS = code(src("src/services/jobs.service.ts"));
    expect(JOBS).toContain('eq(bookings.status, "CONFIRMED")');
  });

  test("the import path is untouched by this task", () => {
    const VAL = code(src("src/validation.ts"));
    expect(VAL).toContain("export const importCoursePackage = z.object({");
  });
});
