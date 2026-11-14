// 🔻 TASK-989 (D-164-1, TEST-164) — on a PATTERN course a planned absence declared at sale marks the ticked ROW (its 1-based position in the previewed plan), not a whole course week.
// The screen sends row positions (`weekIndexOf`); the server used to read them as course weeks, so ticking row 2 of a Sat+Sun pattern absent'd rows 3 AND 4 and a second tick on row 5 was refused.
// Sat+Sun pattern, size 6, start Sat 2026-11-21 → rows: Sat 21 · Sun 22 · Sat 28 · Sun 29 · Sat 5 Dec · Sun 6 Dec. By value through the real preview and the real create (a fake tx); the pure `markAbsentRows`; the refusal.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, notInArray } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import { bookings, courseSlots, coursePackages, teachers } from "../db/schema";
import * as sched from "./scheduler.service";
import * as parentSvc from "./parent.service";
import * as salePost from "../lib/sale-post";
import { markAbsentRows, expandPattern } from "../lib/course-pattern";
import { createCoursePackage as createBody, previewCourse as previewBody } from "../validation";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const dialect = new PgDialect();
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", SUBJ = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SAT = "2026-11-21"; // a Saturday
const PATTERN = [{ weekday: 6, startTime: "10:00", teacherId: T1 }, { weekday: 0, startTime: "10:00", teacherId: T1 }]; // Sat + Sun
const ROWS = ["2026-11-21", "2026-11-22", "2026-11-28", "2026-11-29", "2026-12-05", "2026-12-06"];
const MSG = "ลาล่วงหน้าได้เฉพาะคาบในแผน";
const body = { student: { id: A }, teacherId: T1, subjectId: SUBJ, size: 6, startDate: SAT, startTime: "10:00", pattern: PATTERN };

// ── the pure helper ──
describe("markAbsentRows — positions only", () => {
  const rows = expandPattern(SAT, PATTERN, 6);
  test("row i (1-based) is absent iff the set has i; out-of-range positions are ignored; the input is not mutated", () => {
    const out = markAbsentRows(rows, new Set([2, 5, 7, 99]));
    expect(out.map((r) => r.absent)).toEqual([false, true, false, false, true, false]);
    expect(rows.every((r) => r.absent === false)).toBe(true);
    expect(out.map((r) => r.date)).toEqual(ROWS);
    expect(markAbsentRows(rows, new Set()).every((r) => !r.absent)).toBe(true);
  });
  test("it is NOT the week rule: position 2 marks ONE row (the week rule would mark rows 3 and 4)", () => {
    expect(markAbsentRows(rows, new Set([2])).filter((r) => r.absent).map((r) => r.date)).toEqual(["2026-11-22"]);
  });
});

// ── the validator ──
describe("the bodies: a pattern's absentWeeks are ROW positions ≤ size", () => {
  const ok = (b: unknown) => createBody.safeParse(b);
  const p = (b: unknown) => previewBody.safeParse(b);
  const cb = { student: { id: "11111111-1111-4111-8111-111111111111" }, teacherId: T1, subjectId: SUBJ, size: 6, startDate: SAT, startTime: "10:00", pattern: PATTERN };
  const pb = { teacherId: T1, subjectId: SUBJ, size: 6, startDate: SAT, startTime: "10:00", pattern: PATTERN };
  test("[2], [2,5] and [6] pass; [7] is refused with the row sentence — on the create AND the preview", () => {
    for (const w of [[2], [2, 5], [1, 2], [6]]) { expect(ok({ ...cb, absentWeeks: w }).success).toBe(true); expect(p({ ...pb, absentWeeks: w }).success).toBe(true); }
    for (const r of [ok({ ...cb, absentWeeks: [7] }), p({ ...pb, absentWeeks: [7] })]) {
      expect(r.success).toBe(false);
      expect(JSON.stringify((r as any).error.issues)).toContain(MSG);
    }
  });
  test("a ONE-slot body keeps its own sentence and rule (no pattern)", () => {
    const one = { ...cb, pattern: undefined };
    expect(ok({ ...one, absentWeeks: [1] }).success).toBe(true);
    expect(JSON.stringify((ok({ ...one, absentWeeks: [9] }) as any).error.issues)).toContain("สัปดาห์ที่ลาต้องอยู่ในช่วงของคอร์ส");
  });
});

// ── the preview ──
describe("the PREVIEW of a pattern with declared absences", () => {
  const arm = () => {
    spies.push(spyOn(db.query.subjects, "findFirst").mockImplementation((async () => ({ id: SUBJ, name: "Skate" })) as any));
    spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async (q: any) => ({ id: dialect.sqlToQuery(q.where(teachers, { eq })).params[0] as string, nickname: "Coach", name: "Coach", workHours: null })) as any));
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async (q: any) => { dialect.sqlToQuery(q.where(bookings, { and, eq, notInArray })); return undefined; }) as any));
    spies.push(spyOn(db.query.closedDays, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db.query.teacherLeaveDays, "findFirst").mockImplementation((async () => undefined) as any));
  };
  const kinds = (out: any) => out.sessions.map((s: any) => [s.date, s.absent ? "absent" : s.makeup ? "makeup" : "plan"]);
  test("absentWeeks [2] → ONLY row 2 (Sun 22 Nov) is absent; exactly ONE make-up, Sat 12 Dec (the next pattern slot after the last planned row); liveCount 6", async () => {
    setSystemTime(new Date("2026-11-13T10:00:00+07:00")); arm();
    const out: any = await sched.previewCoursePackage({ ...body, absentWeeks: [2] } as any);
    expect(kinds(out)).toEqual([["2026-11-21", "plan"], ["2026-11-22", "absent"], ["2026-11-28", "plan"], ["2026-11-29", "plan"], ["2026-12-05", "plan"], ["2026-12-06", "plan"], ["2026-12-12", "makeup"]]);
    expect(out.liveCount).toBe(6);
  });
  test("[2, 5] → rows 2 and 5 absent, TWO make-ups, and the request is not refused", async () => {
    setSystemTime(new Date("2026-11-13T10:00:00+07:00")); arm();
    const out: any = await sched.previewCoursePackage({ ...body, absentWeeks: [2, 5] } as any);
    expect(kinds(out).filter(([, k]: any) => k === "absent").map(([d]: any) => d)).toEqual(["2026-11-22", "2026-12-05"]);
    expect(kinds(out).filter(([, k]: any) => k === "makeup")).toHaveLength(2);
    expect(out.liveCount).toBe(6);
  });
  test("no absentWeeks → no absent row, no make-up", async () => {
    setSystemTime(new Date("2026-11-13T10:00:00+07:00")); arm();
    const out: any = await sched.previewCoursePackage(body as any);
    expect(kinds(out).every(([, k]: any) => k === "plan")).toBe(true);
  });
});

// ── the create ──
const fakeCreate = () => {
  const inserted: Array<{ table: string; v: any }> = [];
  let n = 0;
  const slotsInserted = () => inserted.filter((r) => r.table === "courseSlots").flatMap((r) => (Array.isArray(r.v) ? r.v : [r.v]));
  const tx: any = {
    insert: (table: any) => ({ values: (val: any) => { const name = table === coursePackages ? "coursePackages" : table === bookings ? "bookings" : table === courseSlots ? "courseSlots" : "other"; inserted.push({ table: name, v: val }); const p: any = Promise.resolve(); p.returning = async () => [{ id: table === coursePackages ? "course-1" : `b-${++n}` }]; return p; } }),
    select: () => { const q: any = { from: () => q, innerJoin: () => q, where: () => q, orderBy: () => q, limit: async () => [] }; return q; },
    update: () => ({ set: () => ({ where: async () => {} }) }),
    delete: () => ({ where: () => { const p: any = Promise.resolve(); p.returning = async () => [{ id: "x" }]; return p; } }),
    query: {
      closedDays: { findFirst: async () => undefined },
      teacherLeaveDays: { findFirst: async () => undefined },
      students: { findFirst: async () => ({ id: A, parentId: null, archivedAt: null, name: "Ploy", nickname: "Ploy" }) },
      teachers: { findFirst: async () => ({ id: T1, nickname: "Bank", name: "Bank", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME" }) },
      courseSlots: { findMany: async () => slotsInserted() },
      bookings: { findFirst: async () => null, findMany: async () => inserted.filter((r) => r.table === "bookings").map((r, i) => ({ id: `b-${i + 1}`, ...r.v, status: r.v.status ?? "PENDING", student: { id: A, name: "Ploy" }, coStudent: null, teacher: { id: T1, nickname: "Bank", name: "Bank" }, subject: { id: SUBJ, name: "Skate" }, course: null, badges: [], additionalTeachers: [], rental: null, seats: [], group: null, campWeekDay: null })) },
      coursePackages: { findFirst: async () => { const c = inserted.find((r) => r.table === "coursePackages")!.v; return { id: "course-1", ...c, usedSessions: 0, leaveUsed: 0, adminUnlocked: false, priorSessions: 0, leaveQuota: null, createdAt: new Date(), student: { id: A, name: "Ploy", nickname: "Ploy" }, coStudent: null, subject: { id: SUBJ, name: "Skate" }, slots: slotsInserted().map((s: any) => ({ ...s })) }; } },
    },
  };
  return { tx, inserted };
};
const wire = (tx: any) => {
  setSystemTime(new Date("2026-11-13T10:00:00+07:00"));
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(salePost, "recordSale").mockImplementation((async () => ({ status: "posted" })) as any));
  spies.push(spyOn(parentSvc, "assertStudentActive").mockImplementation((async () => {}) as any));
  spies.push(spyOn(db.query.subjects, "findFirst").mockImplementation((async () => ({ id: SUBJ, priceGroup: "bike-skate" })) as any));
};
async function create(absentWeeks?: number[]) {
  const { tx, inserted } = fakeCreate();
  wire(tx);
  await sched.createCoursePackage({ ...body, ...(absentWeeks ? { absentWeeks } : {}) } as any);
  const rows = inserted.filter((r) => r.table === "bookings").map((r) => r.v);
  const course = inserted.find((r) => r.table === "coursePackages")!.v;
  for (const s of spies.splice(0)) s.mockRestore();
  return { rows, course };
}
describe("the CREATE saves what the preview drew", () => {
  test("absentWeeks [2]: row 2 (Sun 22 Nov) is SICK_LEAVE + plannedAtCreation; every other planned row is live; ONE make-up (Sat 12 Dec)", async () => {
    const { rows } = await create([2]);
    const absent = rows.filter((r) => r.status === "SICK_LEAVE");
    expect(absent.map((r) => [r.date, r.plannedAtCreation])).toEqual([["2026-11-22", true]]);
    const live = rows.filter((r) => (r.status ?? "PENDING") !== "SICK_LEAVE").map((r) => r.date).sort();
    expect(live).toEqual(["2026-11-21", "2026-11-28", "2026-11-29", "2026-12-05", "2026-12-06", "2026-12-12"]);
  });
  test("the T1 expiry adds ONE week for [2], and still ONE for [1, 2] (the same course week); [] adds none", async () => {
    const none = (await create()).course.expiryDate as string;
    const two = (await create([2])).course.expiryDate as string;
    const oneTwo = (await create([1, 2])).course.expiryDate as string;
    const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
    expect(days(two, none)).toBe(7);
    expect(oneTwo).toBe(two);
  });
  test("[2, 5]: two planned absences (rows 2 and 5), two make-ups", async () => {
    const { rows } = await create([2, 5]);
    expect(rows.filter((r) => r.status === "SICK_LEAVE").map((r) => r.date).sort()).toEqual(["2026-11-22", "2026-12-05"]);
    expect(rows.filter((r) => (r.status ?? "PENDING") !== "SICK_LEAVE")).toHaveLength(6);
  });
});

describe("by source", () => {
  const S = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n");
  test("the preview and the create both expand with NO absences, then `markAbsentRows` by row position", () => {
    expect(S).toContain("const planned = markAbsentRows(expandPattern(input.startDate, slots, input.size), absent);");
    expect(S).toContain("markAbsentRows(expandPattern(input.startDate, patternSlots, input.size), new Set<number>((input.absentWeeks ?? []) as number[]))");
    expect(S).not.toMatch(/expandPattern\(input\.startDate, (slots|patternSlots), input\.size, (absent|new Set)/);
  });
});
