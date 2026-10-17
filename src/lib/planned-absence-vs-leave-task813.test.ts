// TASK-813 (REQ-123 §4, owner's choice A, LIVE) — at course create, a week the family ticked as PLANNED ABSENCE is not refused because the teacher is on advance leave that day:
// it is not a class. Tanya on sid (TEST-107): create → 409 TEACHER_ON_LEAVE even with `absentWeeks: [3]`, Private AND DUO.
// The recipe, by value through the real `createCoursePackage` (a fake tx): ticked ⇒ CREATED (Private + DUO) · not ticked ⇒ still refused, the exact text · two leave days, one ticked ⇒ still
// refused (on the un-ticked one) · the leave day stays recorded · the make-up appended at the end is NOT on a leave day. And the skip is narrow: only `insertBooking`, only a row born
// `SICK_LEAVE` + `plannedAtCreation`; the gate's other checks and every other door are untouched (pinned by value and by source).
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as sched from "../services/scheduler.service";
import * as parentSvc from "../services/parent.service";
import * as salePost from "./sale-post";
import { db } from "../db";
import { bookings, coursePackages } from "../db/schema";

const root = resolve(import.meta.dir, "..", "..");
const SVC = readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => { const a = s.indexOf(from); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf(to, a + from.length)); };
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", SUBJ = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

/** A `where` callback evaluated into { column: value } pairs — the service's own callback, not a canned answer. */
const whereOf = (q: any): Record<string, unknown> => {
  const pairs = [q?.where?.(new Proxy({}, { get: (_t, k) => String(k) }), { and: (...a: any[]) => a.flat(), eq: (c: string, v: unknown) => [[c, v]] })].flat(3);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < pairs.length; i += 2) out[pairs[i] as string] = pairs[i + 1];
  return out;
};

// Course Mon 2026-10-05, four weekly sessions: week 1 = 10-05 · 2 = 10-12 · 3 = 10-19 · 4 = 10-26.
const D3 = "2026-10-19", D4 = "2026-10-26";
const body = { student: { id: A }, teacherId: T1, subjectId: SUBJ, size: 4, startDate: "2026-10-05", startTime: "10:00" };
const LEAVE_REFUSAL = (d: string) => `ครู Bank ลาวันที่ ${d} — เพิ่มคาบกับครูในวันนั้นไม่ได้ กรุณาเลือกครูอื่นหรือวันอื่น`;

const fakeCreate = (leave: Array<{ teacherId: string; date: string }>) => {
  const inserted: Array<{ table: string; v: any }> = [];
  const touchedLeaveTable: string[] = [];
  let n = 0;
  const tx: any = {
    insert: (table: any) => ({ values: (val: any) => ({ returning: async () => { const id = table === coursePackages ? "course-1" : `b-${++n}`; inserted.push({ table: table === coursePackages ? "coursePackages" : table === bookings ? "bookings" : "other", v: val }); return [{ id }]; } }) }),
    // the make-up appended by the reconcile asks "does this course carry a rental?" — none here (an empty chain)
    select: () => { const q: any = { from: () => q, innerJoin: () => q, where: () => q, limit: async () => [] }; return q; },
    update: (t: any) => ({ set: () => ({ where: async () => { touchedLeaveTable.push(String(t?.[Symbol.for("drizzle:Name")] ?? "")); } }) }),
    delete: (t: any) => ({ where: () => { touchedLeaveTable.push(`delete:${String(t?.[Symbol.for("drizzle:Name")] ?? "")}`); const p: any = Promise.resolve(); p.returning = async () => [{ id: "x" }]; return p; } }),
    query: {
      teacherLeaveDays: { findFirst: async (q: any) => { const w = whereOf(q); return leave.find((r) => r.teacherId === w.teacherId && r.date === w.date); } },
      students: { findFirst: async ({ where }: any) => { const probe: string[] = []; where({ id: "id" }, { eq: (_: any, x: string) => { probe.push(x); return null; } }); const id = probe[0]!; return { id, parentId: null, archivedAt: null, name: id === A ? "Ploy" : "Pun", nickname: id === A ? "Ploy" : "Pun" }; } },
      teachers: { findFirst: async () => ({ id: T1, nickname: "Bank", name: "Bank", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME" }) },
      bookings: { findFirst: async () => null, findMany: async () => inserted.filter((r) => r.table === "bookings").map((r, i) => ({ id: `b-${i + 1}`, ...r.v, status: r.v.status ?? "PENDING", student: { id: A, name: "Ploy" }, coStudent: r.v.coStudentId ? { id: B, name: "Pun" } : null, teacher: { id: T1, nickname: "Bank", name: "Bank" }, subject: { id: SUBJ, name: "Balance" }, course: null, badges: [], additionalTeachers: [], rental: null, seats: [], group: null, campWeekDay: null })) },
      coursePackages: { findFirst: async () => { const c = inserted.find((r) => r.table === "coursePackages")!.v; return { id: "course-1", ...c, usedSessions: 0, leaveUsed: 0, adminUnlocked: false, priorSessions: 0, leaveQuota: null, createdAt: new Date(), student: { id: A, name: "Ploy", nickname: "Ploy" }, coStudent: c.coStudentId ? { id: B, name: "Pun", nickname: "Pun" } : null, subject: { id: SUBJ, name: "Balance" } }; } },
    },
  };
  return { tx, inserted, touchedLeaveTable };
};
const wire = (tx: any, kind: "PRIVATE" | "DUO") => {
  setSystemTime(new Date("2026-10-01T10:00:00+07:00")); // every session is today-or-later ⇒ an advance leave FIRES on it
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(salePost, "recordSale").mockImplementation((async () => ({ status: "posted" })) as any));
  spies.push(spyOn(parentSvc, "assertStudentActive").mockImplementation((async () => {}) as any));
  spies.push(spyOn(db.query.subjects, "findFirst").mockImplementation((async () => (kind === "DUO" ? { id: SUBJ, priceGroup: "balance-duo", kind: "DUO" } : { id: SUBJ, priceGroup: "bike-skate" })) as any));
};
const input = (kind: "PRIVATE" | "DUO", absentWeeks?: number[]) => ({ ...body, ...(kind === "DUO" ? { duo: { coStudentId: B, classRateMinor: 40000 } } : {}), ...(absentWeeks ? { absentWeeks } : {}) });

describe("🔴 the REQ-123 §4 recipe, by value — Private AND DUO", () => {
  for (const kind of ["PRIVATE", "DUO"] as const) {
    test(`${kind}: the teacher on leave on week 3, that week TICKED ⇒ the course is CREATED; the week is SICK_LEAVE + plannedAtCreation; the make-up is NOT on a leave day; the leave day stays recorded`, async () => {
      const leave = [{ teacherId: T1, date: D3 }];
      const { tx, inserted, touchedLeaveTable } = fakeCreate(leave);
      wire(tx, kind);
      const out: any = await sched.createCoursePackage(input(kind, [3]));
      expect(out.course).toMatchObject({ courseKind: kind });
      const rows = inserted.filter((r) => r.table === "bookings").map((r) => r.v);
      const d3 = rows.filter((r) => r.date === D3);
      expect(d3).toHaveLength(1);
      expect(d3[0]).toMatchObject({ status: "SICK_LEAVE", plannedAtCreation: true });
      // size 4 ⇒ 3 live sessions + the absence + ONE appended make-up; none of the LIVE rows sits on the leave day
      const live = rows.filter((r) => (r.status ?? "PENDING") !== "SICK_LEAVE");
      expect(live).toHaveLength(4);
      expect(live.every((r) => r.date !== D3)).toBe(true);
      expect(live.map((r) => r.date).sort()).toEqual(["2026-10-05", "2026-10-12", "2026-10-26", "2026-11-02"]);
      // the leave day is still recorded, and nothing touched the leave table
      expect(leave).toEqual([{ teacherId: T1, date: D3 }]);
      expect(touchedLeaveTable.filter((t) => /leave/i.test(t))).toEqual([]);
    });

    test(`${kind}: the SAME course, week 3 NOT ticked ⇒ still refused — 409 TEACHER_ON_LEAVE, the exact existing text; nothing written for the course's sale`, async () => {
      const { tx } = fakeCreate([{ teacherId: T1, date: D3 }]);
      wire(tx, kind);
      const e: any = await sched.createCoursePackage(input(kind)).catch((x) => x);
      expect([e.status, e.code, e.message]).toEqual([409, "TEACHER_ON_LEAVE", LEAVE_REFUSAL(D3)]);
      const e2: any = await sched.createCoursePackage(input(kind, [1])).catch((x) => x); // a DIFFERENT week ticked — week 3 is still a class
      expect([e2.status, e2.code, e2.message]).toEqual([409, "TEACHER_ON_LEAVE", LEAVE_REFUSAL(D3)]);
    });

    test(`${kind}: TWO leave days (weeks 3 and 4), only week 3 ticked ⇒ still refused — on the un-ticked day`, async () => {
      const { tx } = fakeCreate([{ teacherId: T1, date: D3 }, { teacherId: T1, date: D4 }]);
      wire(tx, kind);
      const e: any = await sched.createCoursePackage(input(kind, [3])).catch((x) => x);
      expect([e.status, e.code, e.message]).toEqual([409, "TEACHER_ON_LEAVE", LEAVE_REFUSAL(D4)]);
    });
  }

  test("both leave days ticked ⇒ created (each is a planned absence)", async () => {
    const { tx, inserted } = fakeCreate([{ teacherId: T1, date: D3 }, { teacherId: T1, date: D4 }]);
    wire(tx, "PRIVATE");
    await sched.createCoursePackage(input("PRIVATE", [3, 4]));
    const rows = inserted.filter((r) => r.table === "bookings").map((r) => r.v);
    expect(rows.filter((r) => r.status === "SICK_LEAVE" && r.plannedAtCreation === true).map((r) => r.date).sort()).toEqual([D3, D4]);
    expect(rows.filter((r) => (r.status ?? "PENDING") !== "SICK_LEAVE").every((r) => r.date !== D3 && r.date !== D4)).toBe(true);
  });

  test("a planned absence on a day with NO leave behaves as before (no leave row ⇒ created)", async () => {
    const { tx, inserted } = fakeCreate([]);
    wire(tx, "PRIVATE");
    await sched.createCoursePackage(input("PRIVATE", [3]));
    expect(inserted.filter((r) => r.table === "bookings" && r.v.date === D3).map((r) => r.v.status)).toEqual(["SICK_LEAVE"]);
  });
});

describe("🔴 the skip is NARROW — by value at `insertBooking`", () => {
  const exec = (leave: Array<{ teacherId: string; date: string }>, teacher: any = {}) => ({
    query: {
      teachers: { findFirst: async () => ({ id: T1, nickname: "Bank", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME", ...teacher }) },
      teacherLeaveDays: { findFirst: async (q: any) => { const w = whereOf(q); return leave.find((r) => r.teacherId === w.teacherId && r.date === w.date); } },
      boItem: { findFirst: async () => null }, // no freelance budget row
    },
  });
  const LEAVE = [{ teacherId: T1, date: D3 }];
  const row = (extra: object) => ({ teacherId: T1, subjectId: SUBJ, date: D3, startTime: "10:00", bookingType: "COURSE_PACKAGE", ...extra });
  test("a row that is SICK_LEAVE but NOT `plannedAtCreation`, one that is `plannedAtCreation` but not SICK_LEAVE, and a normal row ⇒ all refused by the leave day", async () => {
    setSystemTime(new Date("2026-10-01T10:00:00+07:00"));
    for (const extra of [{ status: "SICK_LEAVE" }, { plannedAtCreation: true }, {}, { status: "SICK_LEAVE", plannedAtCreation: false }, { status: "CONFIRMED", plannedAtCreation: true }]) {
      const e: any = await sched.insertBooking(exec(LEAVE), A, row(extra)).catch((x) => x);
      expect({ extra, code: e?.code }).toEqual({ extra, code: "TEACHER_ON_LEAVE" });
    }
  });
  test("the gate itself: `allowLeave` skips ONLY the leave check — an archived teacher, a day off and a freelance teacher with no budget are still refused", async () => {
    setSystemTime(new Date("2026-10-01T10:00:00+07:00"));
    const open = { allowLeave: true };
    expect(((await sched.assertTeacherBookable(exec(LEAVE), T1, D3, open)) as any).id).toBe(T1); // leave day + allowLeave ⇒ passes
    const arch: any = await sched.assertTeacherBookable(exec(LEAVE, { archived: true }), T1, D3, open).catch((x) => x);
    expect(arch.message).toContain("ถูกปิดการใช้งานแล้ว");
    const monday = new Date(`${D3}T00:00:00Z`).getUTCDay();
    const offDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== monday);
    const off2: any = await sched.assertTeacherBookable(exec(LEAVE, { workDays: offDays }), T1, D3, open).catch((x) => x);
    expect(String(off2.message)).toContain("ไม่ได้สอนวัน");
    const noBudget: any = await sched.assertTeacherBookable(exec(LEAVE, { type: "FREELANCE" }), T1, D3, open).catch((x) => x);
    expect(String(noBudget.message)).toContain("ยังไม่ได้ตั้งงบ");
    // without allowLeave the leave day still refuses
    const refused: any = await sched.assertTeacherBookable(exec(LEAVE), T1, D3).catch((x) => x);
    expect(refused.code).toBe("TEACHER_ON_LEAVE");
  });
});

describe("TASK-813 — by source: one place, one reader, nothing else moved", () => {
  const GATE = code(region(SVC, "export async function assertTeacherBookable(", "\n}\n"));
  const INSERT = code(region(SVC, "export async function insertBooking(", "\n}\n"));
  test("the skip is passed ONLY by `insertBooking`, ONLY for `SICK_LEAVE` + `plannedAtCreation === true`", () => {
    expect([...code(SVC).matchAll(/allowLeave: true/g)]).toHaveLength(1);
    expect(INSERT).toContain('if (input.status === "SICK_LEAVE" && input.plannedAtCreation === true) await assertTeacherBookable(exec, input.teacherId, input.date, { allowLeave: true });');
    expect(INSERT).toContain("else await assertTeacherBookable(exec, input.teacherId, input.date);");
  });
  test("the gate keeps ONE reader and ONE text; the leave check is the only thing `allowLeave` guards", () => {
    expect(GATE).toContain("if (!opts.allowLeave) {\n    if (await teacherLeaveOn(exec, teacher.id, date)) throw TEACHER_ON_LEAVE(teacher.nickname, date);\n  }");
    expect([...GATE.matchAll(/opts\.allowLeave/g)]).toHaveLength(1);
    expect(GATE).toContain("if (!teacher) throw badRequest");
    expect(GATE).toContain("teacher.archived");
    expect(GATE).toContain("teacherWorksOnDay(");
    expect(GATE).toContain("isFreelanceSetupIncomplete(");
  });
  test("every OTHER caller of the gate passes no `allowLeave` — every other door still refuses a leave day", () => {
    const callers = [...code(SVC).matchAll(/await assertTeacherBookable\(([^;]*)\);/g)].map((m) => m[1]!);
    expect(callers.filter((c) => c.includes("allowLeave"))).toHaveLength(1);
    expect(callers.length).toBeGreaterThanOrEqual(10);
  });
  test("the make-up appended at the end still skips leave days (Seam B) and `createCoursePackage` writes no leave row", () => {
    const CREATE = code(region(SVC, "export async function createCoursePackage(", "\n}\n"));
    expect(CREATE).not.toMatch(/teacherLeaveDays|teacher_leave_days|liftAdvanceLeave|recordAdvanceLeave/);
    expect(code(region(SVC, "export async function findFreeExtensionDate(", "\n}\n"))).toContain("if (await teacherLeaveOn(exec, teacherId, d)) return true;");
  });
});
