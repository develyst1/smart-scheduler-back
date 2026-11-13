// TASK-965 (REQ-5015, SPEC-108) — COACH TIME RANGES: a PART-day leave and a coach's WORKING HOURS.
//   · the overlap rule, pure and by value (10–12 blocks 10:00 and 11:00, never 09:00 or 12:00); the SQL twin agrees with it;
//   · THE reader `teacherLeaveOn(…, startTime?)` and the gate `assertTeacherBookable` (leave + hours), by value;
//   · the make-up search skips only the blocked HOURS; a whole-day leave behaves exactly as before (AC4);
//   · working hours: the refusal text, the exemptions (make-up, planned absence), the picker, the orphan warning;
//   · the act: a part-day window lists only the overlapping classes; a range applies the same window to every day;
//   · the doors (R1): every `teacherLeaveOn` / `assertTeacherBookable` call passes the class's time — pinned by count;
//   · the contract: the bodies, the DTOs, the migration, the journal, the witness.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { teacherLeaveDays } from "../db/schema";
import * as sched from "../services/scheduler.service";
import { ApiException } from "./http";
import { OUTSIDE_WORK_HOURS, leaveBlocksSlot, leaveDayBookings, recordAdvanceLeave, recordAdvanceLeaveRange, recordedLeaveDays, teacherLeaveOn } from "./teacher-leave";
import { CLASS_MINUTES, classFitsWorkHours, clockMinutes, workHoursOn } from "./work-days";
import { adminTeacherLeaveBody, setTeacherWorkDays, workDaysImpactQuery } from "../validation";
import { SCHEDULING_WITNESSES } from "./migration-witness";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n"); // LF, whatever the checkout's endings
const code = (s: string) => s.replace(/\/\/[^\n]*/g, ""); // comments out: a pin reads CODE
const dialect = new PgDialect();
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });
const NOW = "2026-11-13T10:00:00+07:00"; // Bangkok Friday 13 Nov 2026
const T1 = "t1t1t1t1-t1t1-41t1-81t1-t1t1t1t1t1t1";
const SAT = "2026-11-21"; // a Saturday (weekday 6)
const SUN = "2026-11-22"; // a Sunday (weekday 0)
const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof ApiException) return { status: e.status, code: e.code, message: e.message }; throw e; } return null; };

type Leave = { date: string; startTime?: string | null; endTime?: string | null };
/** An exec answering the leave / closed-day / teacher reads. The leave read evaluates the REAL where-clause's parameters (the date), and returns the matching row with its window. */
function execOf(o: { leave?: Leave[]; teacher?: any } = {}) {
  const dateOf = (cond: any) => (dialect.sqlToQuery(cond).params as unknown[]).find((p) => typeof p === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p)) as string | undefined;
  return {
    query: {
      teachers: { findFirst: async () => ({ id: T1, nickname: "Ek", archived: false, isSystem: false, workDays: [0, 1, 2, 3, 4, 5, 6], workHours: null, type: "FULL_TIME", ...(o.teacher ?? {}) }) },
      closedDays: { findFirst: async () => undefined },
      teacherLeaveDays: { findFirst: async (q: any) => { const d = dateOf(q.where(teacherLeaveDays, { and, eq })); const r = (o.leave ?? []).find((l) => l.date === d); return r ? { id: "l1", startTime: null, endTime: null, ...r } : undefined; } },
    },
  } as any;
}
const SLOTS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);

describe("SPEC §3.1 — the overlap rule: a class at HH:MM occupies [HH:MM, HH:MM+1h)", () => {
  const w = { startTime: "10:00:00", endTime: "12:00:00" };
  test("a 10–12 leave blocks 10:00 and 11:00 — and NOT 09:00 nor 12:00 (the DB's HH:MM:SS and the picker's HH:MM read alike)", () => {
    expect(["09:00", "10:00", "11:00", "12:00"].map((t) => leaveBlocksSlot(w, t))).toEqual([false, true, true, false]);
    expect(["09:00:00", "10:00:00", "11:00:00", "12:00:00"].map((t) => leaveBlocksSlot(w, t))).toEqual([false, true, true, false]);
  });
  test("the half hours: 09:30 overlaps 10:00 (it runs to 10:30), 11:30 overlaps, 12:30 does not", () => {
    expect(["09:00", "09:30", "11:30", "12:00", "12:30"].map((t) => leaveBlocksSlot(w, t))).toEqual([false, true, true, false, false]);
  });
  test("a WHOLE-day row (NULL times — every row before this task) blocks every class; a day-level question (no time) gets any row", () => {
    expect(SLOTS.every((t) => leaveBlocksSlot({ startTime: null, endTime: null }, t))).toBe(true);
    expect(leaveBlocksSlot({}, "03:00")).toBe(true);
    expect(leaveBlocksSlot(w, undefined)).toBe(true);
    expect(leaveBlocksSlot(w, null)).toBe(true);
  });
  test("`leaveDayBookings`' SQL twin agrees with the pure rule on every half-hour slot, for several windows (`start < to AND start > from − 1h`)", () => {
    const twin = (slot: string, from: string, to: string) => clockMinutes(slot) < clockMinutes(to) && clockMinutes(slot) > clockMinutes(from) - CLASS_MINUTES;
    for (const [from, to] of [["10:00", "12:00"], ["09:30", "10:30"], ["00:00", "23:30"], ["13:00", "13:30"], ["17:30", "18:00"]]) {
      for (const s of SLOTS) expect({ from, to, s, sql: twin(s, from, to) }).toEqual({ from, to, s, sql: leaveBlocksSlot({ startTime: from, endTime: to }, s) });
    }
  });
});

describe("`leaveDayBookings` — the part-day window reaches the ONE query, as parameters", () => {
  const capture = () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const exec: any = { select: () => ({ from: () => ({ where: (c: any) => { const q = dialect.sqlToQuery(c); seen.push({ sql: q.sql, params: q.params as unknown[] }); return { orderBy: async () => [] }; } }) }) };
    return { exec, seen };
  };
  test("with a window: the overlap predicate and its two times are in the where-clause; without: byte-for-byte today's query", async () => {
    const a = capture(); await leaveDayBookings(a.exec, T1, "2026-11-20", { startTime: "10:00:00", endTime: "12:00:00" });
    const b = capture(); await leaveDayBookings(b.exec, T1, "2026-11-20");
    const c = capture(); await leaveDayBookings(c.exec, T1, "2026-11-20", { startTime: null, endTime: null });
    expect(a.seen[0]!.sql).toContain('"start_time" < $');
    expect(a.seen[0]!.sql).toContain("::time - interval '1 hour'");
    expect(a.seen[0]!.params).toEqual(expect.arrayContaining(["12:00:00", "10:00:00"]));
    expect(b.seen[0]!.sql).not.toContain("interval '1 hour'");
    expect(c.seen[0]).toEqual(b.seen[0]); // a whole-day row (null times) asks exactly what a no-window caller asks
  });
});

describe("THE reader — `teacherLeaveOn(exec, teacher, date, startTime?)`", () => {
  test("a 10–12 leave: the row for 10:00 and 11:00, null for 09:00 and 12:00; no time = the day-level answer", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf({ leave: [{ date: "2026-11-20", startTime: "10:00:00", endTime: "12:00:00" }] });
    const at = async (t?: string) => !!(await teacherLeaveOn(exec, T1, "2026-11-20", t));
    expect([await at("09:00"), await at("10:00"), await at("11:00"), await at("12:00"), await at()]).toEqual([false, true, true, false, true]);
    expect(await teacherLeaveOn(exec, T1, "2026-11-21", "10:00")).toBeNull(); // another day
  });
  test("a WHOLE-day leave behaves as before: every time blocks; the back-dated write still never meets it", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf({ leave: [{ date: "2026-11-20" }, { date: "2026-11-12" }] });
    for (const t of ["06:00", "10:00", "19:00"]) expect(await teacherLeaveOn(exec, T1, "2026-11-20", t)).toMatchObject({ id: "l1" });
    expect(await teacherLeaveOn(exec, T1, "2026-11-12", "10:00")).toBeNull(); // yesterday: history
  });
});

describe("`assertTeacherBookable` — the part-day leave and the working hours, by value", () => {
  test("a 10–12 leave refuses a class at 10:00 / 11:00 with the approved TEACHER_ON_LEAVE words, and lets 09:00 / 12:00 / 15:00 through", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf({ leave: [{ date: "2026-11-20", startTime: "10:00:00", endTime: "12:00:00" }] });
    for (const t of ["10:00", "11:00"]) expect(await refusal(sched.assertTeacherBookable(exec, T1, "2026-11-20", { startTime: t }))).toMatchObject({ status: 409, code: "TEACHER_ON_LEAVE" });
    for (const t of ["09:00", "12:00", "15:00"]) expect(await sched.assertTeacherBookable(exec, T1, "2026-11-20", { startTime: t })).toMatchObject({ id: T1 });
  });
  test("a caller with NO time is a day-level question: the part-day row still refuses it (safe: it refuses more, never less — R1)", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf({ leave: [{ date: "2026-11-20", startTime: "10:00:00", endTime: "12:00:00" }] });
    expect(await refusal(sched.assertTeacherBookable(exec, T1, "2026-11-20"))).toMatchObject({ code: "TEACHER_ON_LEAVE" });
  });
  test("a WHOLE-day leave refuses every time, as before", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf({ leave: [{ date: "2026-11-20" }] });
    for (const t of ["09:00", "15:00"]) expect(await refusal(sched.assertTeacherBookable(exec, T1, "2026-11-20", { startTime: t }))).toMatchObject({ code: "TEACHER_ON_LEAVE" });
  });
  const hours13to17 = { teacher: { workHours: { "6": ["13:00", "17:00"] } } };
  test("hours 13–17 on Saturday: the 16:00 class fits (it ends at 17:00); 17:00 is refused with SPEC-108's words; 12:00 is refused too", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf(hours13to17);
    expect(await sched.assertTeacherBookable(exec, T1, SAT, { startTime: "16:00" })).toMatchObject({ id: T1 });
    expect(await sched.assertTeacherBookable(exec, T1, SAT, { startTime: "13:00" })).toMatchObject({ id: T1 });
    expect(await refusal(sched.assertTeacherBookable(exec, T1, SAT, { startTime: "17:00" }))).toEqual({ status: 400, code: "VALIDATION", message: "ครู Ek ทำงานวันเสาร์ เวลา 13:00–17:00 — กรุณาเลือกเวลาอื่นหรือครูอื่น" });
    expect(await refusal(sched.assertTeacherBookable(exec, T1, SAT, { startTime: "12:00" }))).toMatchObject({ status: 400 });
    expect(await refusal(sched.assertTeacherBookable(exec, T1, SAT, { startTime: "16:30" }))).toMatchObject({ status: 400 }); // 16:30 runs to 17:30
  });
  test("exempt: a MAKE-UP / planned absence (`allowOutsideHours`) is never refused; a caller with no time, and a weekday with no window, are not judged", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf(hours13to17);
    expect(await sched.assertTeacherBookable(exec, T1, SAT, { startTime: "17:00", allowOutsideHours: true })).toMatchObject({ id: T1 });
    expect(await sched.assertTeacherBookable(exec, T1, SAT)).toMatchObject({ id: T1 });
    expect(await sched.assertTeacherBookable(exec, T1, SUN, { startTime: "08:00" })).toMatchObject({ id: T1 }); // Sunday has no key = the whole day
  });
  test("the hours check sits AFTER the workday check and BEFORE the leave check (one refusal each, in that order)", async () => {
    setSystemTime(new Date(NOW));
    const both = execOf({ teacher: { workHours: { "6": ["13:00", "17:00"] } }, leave: [{ date: SAT }] });
    expect(await refusal(sched.assertTeacherBookable(both, T1, SAT, { startTime: "18:00" }))).toMatchObject({ status: 400 }); // outside hours first
    expect(await refusal(sched.assertTeacherBookable(both, T1, SAT, { startTime: "14:00" }))).toMatchObject({ code: "TEACHER_ON_LEAVE" });
  });
  test("the words: `ครู {nickname} ทำงานวัน{weekday} เวลา {from}–{to} — กรุณาเลือกเวลาอื่นหรือครูอื่น`", () => {
    expect((OUTSIDE_WORK_HOURS("Ek", 0, ["13:00:00", "18:00:00"]) as ApiException).message).toBe("ครู Ek ทำงานวันอาทิตย์ เวลา 13:00–18:00 — กรุณาเลือกเวลาอื่นหรือครูอื่น");
  });
});

describe("the pure hours rule — `classFitsWorkHours` / `workHoursOn`", () => {
  test("no hours / no key = the whole day; a window needs the class's WHOLE hour inside it", () => {
    expect(classFitsWorkHours(null, 6, "05:00")).toBe(true);
    expect(classFitsWorkHours({ "6": ["13:00", "18:00"] }, 0, "05:00")).toBe(true);
    expect(["12:30", "13:00", "17:00", "17:30", "18:00"].map((t) => classFitsWorkHours({ "6": ["13:00", "18:00"] }, 6, t))).toEqual([false, true, true, false, false]);
    expect(workHoursOn({ "6": ["13:00", "18:00"] }, 6)).toEqual(["13:00", "18:00"]);
    expect(workHoursOn({ "6": ["13:00", "18:00"] }, 5)).toBeNull();
    expect(workHoursOn(undefined, 5)).toBeNull();
  });
});

describe("`insertBooking` hands the gate the class's time and the exemptions", () => {
  const capture = async (input: any) => {
    const seen: any[] = [];
    spies.push(spyOn(sched, "assertTeacherBookable").mockImplementation((async (_e: any, _t: string, _d: string, opts: any) => { seen.push(opts); throw new Error("stop"); }) as any));
    await sched.insertBooking({} as any, null, { teacherId: T1, date: "2026-11-20", bookingType: "PRIVATE", ...input }).catch(() => {});
    return seen[0];
  };
  test("a normal class: its time, hours judged; a make-up (carries `extendedFromId`): hours EXEMPT; a planned absence: hours EXEMPT (and the leave skip it already had)", async () => {
    expect(await capture({ startTime: "17:00" })).toMatchObject({ startTime: "17:00", allowOutsideHours: false });
    expect(await capture({ startTime: "17:00", extendedFromId: "leave-row" })).toMatchObject({ startTime: "17:00", allowOutsideHours: true });
    expect(await capture({ startTime: "17:00", status: "SICK_LEAVE", plannedAtCreation: true })).toMatchObject({ allowLeave: true, allowOutsideHours: true });
  });
});

describe("SPEC §3.2 — Seam B: the make-up skips only the blocked HOURS", () => {
  const fake = (leave: Leave[]) => {
    const e = execOf({ leave });
    e.query.bookings = { findFirst: async () => undefined };
    return e;
  };
  test("a 10–12 leave on week 2: a 10:00 make-up lands one week later; a 15:00 make-up still lands on that day", async () => {
    setSystemTime(new Date(NOW));
    const exec = fake([{ date: "2026-11-27", startTime: "10:00:00", endTime: "12:00:00" }]);
    expect(await sched.findFreeExtensionDate(exec, T1, "10:00", "2026-11-20")).toBe("2026-12-04");
    expect(await sched.findFreeExtensionDate(exec, T1, "15:00", "2026-11-20")).toBe("2026-11-27");
  });
  test("a WHOLE-day leave on week 2 skips it at every time, as before (AC4)", async () => {
    setSystemTime(new Date(NOW));
    const exec = fake([{ date: "2026-11-27" }]);
    expect(await sched.findFreeExtensionDate(exec, T1, "10:00", "2026-11-20")).toBe("2026-12-04");
    expect(await sched.findFreeExtensionDate(exec, T1, "15:00", "2026-11-20")).toBe("2026-12-04");
  });
});

describe("SPEC §3.4 — the slot picker skips a coach outside their hours, as it skips an off day", () => {
  test("Saturday 13–17: 16:00 lists the coach, 17:00 and 09:00 do not; a coach with no hours is always listed", async () => {
    const { db } = await import("../db");
    const teachers = [
      { id: "ek", name: "Ek", nickname: "Ek", type: "FULL_TIME", workDays: [0, 1, 2, 3, 4, 5, 6], workHours: { "6": ["13:00", "17:00"] } },
      { id: "nok", name: "Nok", nickname: "Nok", type: "FULL_TIME", workDays: [0, 1, 2, 3, 4, 5, 6], workHours: null },
    ];
    spies.push(spyOn(db.query.teachers, "findMany").mockImplementation((async () => teachers) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => []) as any));
    const names = async (t: string) => (await sched.getSlotAvailability(SAT, t)).teachers.map((x: any) => x.teacher.nickname);
    expect(await names("16:00")).toEqual(["Ek", "Nok"]);
    expect(await names("17:00")).toEqual(["Nok"]);
    expect(await names("09:00")).toEqual(["Nok"]);
  });
});

describe("SPEC §3.3 — the advance-leave act: a part-day window lists only the overlapping classes", () => {
  /** An exec that records what `recordAdvanceLeave` inserts and what window it asks `leaveDayBookings` for. */
  function actExec(existing?: any) {
    const inserted: any[] = [];
    const windows: any[] = [];
    const exec: any = {
      insert: () => ({ values: (v: any) => { inserted.push(v); return { onConflictDoNothing: () => ({ returning: async () => (existing ? [] : [{ id: `l-${inserted.length}`, ...v }]) }) }; } }),
      query: { teacherLeaveDays: { findFirst: async () => existing } },
      select: () => ({ from: () => ({ where: (c: any) => { windows.push(dialect.sqlToQuery(c).params); return { orderBy: async () => [] }; } }) }),
    };
    return { exec, inserted, windows };
  }
  test("a single day with a window: the row stores it, the answer carries it (HH:MM), the class list is asked for THAT window", async () => {
    setSystemTime(new Date(NOW));
    const { exec, inserted, windows } = actExec();
    const r = await recordAdvanceLeave(exec, T1, { date: "2026-11-20", reason: "ธุระ", startTime: "10:00", endTime: "12:00" }, "admin");
    expect(inserted[0]).toMatchObject({ startTime: "10:00", endTime: "12:00" });
    expect(r.leave).toEqual({ date: "2026-11-20", reason: "ธุระ", startTime: "10:00", endTime: "12:00" });
    expect(windows[0]).toEqual(expect.arrayContaining(["12:00", "10:00"]));
  });
  test("a WHOLE-day record is written and answered EXACTLY as before: no time columns, `leave` has only date + reason", async () => {
    setSystemTime(new Date(NOW));
    const { exec, inserted } = actExec();
    const r = await recordAdvanceLeave(exec, T1, { date: "2026-11-20", reason: "ธุระ" }, "admin");
    expect(Object.keys(inserted[0])).not.toContain("startTime");
    expect(r.leave).toEqual({ date: "2026-11-20", reason: "ธุระ" });
  });
  test("a day ALREADY recorded: the record that stands (its own window) decides the class list — a re-record never widens it", async () => {
    setSystemTime(new Date(NOW));
    const { exec, windows } = actExec({ id: "old", date: "2026-11-20", reason: "x", startTime: "14:00:00", endTime: "15:00:00" });
    const r = await recordAdvanceLeave(exec, T1, { date: "2026-11-20", reason: "y", startTime: "09:00", endTime: "18:00" }, "admin");
    expect(r.alreadyRecorded).toBe(true);
    expect(r.leave).toMatchObject({ startTime: "14:00", endTime: "15:00" });
    expect(windows[0]).toEqual(expect.arrayContaining(["15:00:00", "14:00:00"]));
  });
  test("a RANGE with a time applies the SAME window to every day (one shared range id)", async () => {
    setSystemTime(new Date(NOW));
    const { exec, inserted } = actExec();
    const r = await recordAdvanceLeaveRange(exec, T1, { from: "2026-11-20", to: "2026-11-22", reason: "ธุระ", startTime: "10:00", endTime: "12:00" }, "admin");
    expect(inserted.map((v) => [v.date, v.startTime, v.endTime])).toEqual([["2026-11-20", "10:00", "12:00"], ["2026-11-21", "10:00", "12:00"], ["2026-11-22", "10:00", "12:00"]]);
    expect(new Set(inserted.map((v) => v.rangeId)).size).toBe(1);
    expect(r.days.every((d) => d.startTime === "10:00" && d.endTime === "12:00")).toBe(true);
  });
  test("`GET /teacher-leave-days`: every row carries `startTime`/`endTime` as HH:MM, or null for the whole day, and its class list follows its own window", async () => {
    const rows = [
      { teacherId: "t1", teacherName: "Ek", date: "2026-11-20", reason: "a", createdBy: "u", rangeId: null, startTime: "10:00:00", endTime: "12:00:00" },
      { teacherId: "t1", teacherName: "Ek", date: "2026-11-21", reason: "b", createdBy: "u", rangeId: null, startTime: null, endTime: null },
    ];
    const windows: unknown[][] = [];
    let n = 0;
    const exec: any = {
      select: () => ({
        from: () => (n++ === 0
          ? { innerJoin: () => ({ where: () => ({ orderBy: async () => rows }) }) }
          : { where: (c: any) => { windows.push(dialect.sqlToQuery(c).params as unknown[]); return { orderBy: async () => [] }; } }),
      }),
    };
    const out = await recordedLeaveDays(exec, "2026-11-01", "2026-11-30");
    expect(out.map((d) => [d.date, d.startTime, d.endTime])).toEqual([["2026-11-20", "10:00", "12:00"], ["2026-11-21", null, null]]);
    expect(windows[0]).toEqual(expect.arrayContaining(["12:00:00", "10:00:00"]));
    expect(windows[1]).not.toEqual(expect.arrayContaining(["12:00:00"]));
  });
});

describe("SPEC §4 — the bodies", () => {
  const base = { teacherId: "11111111-1111-4111-8111-111111111111", reason: "ธุระ", date: "2026-11-20" };
  const ok = (b: unknown) => adminTeacherLeaveBody.safeParse(b);
  test("`startTime` + `endTime`: both or neither; start < end; on the hour or the half hour; never with `sessionIds`", () => {
    expect(ok({ ...base, startTime: "10:00", endTime: "12:30" })).toMatchObject({ success: true, data: { startTime: "10:00", endTime: "12:30", date: "2026-11-20" } });
    expect(ok(base)).toMatchObject({ success: true });
    expect((ok(base) as any).data).not.toHaveProperty("startTime"); // a whole-day body is parsed exactly as before
    expect(ok({ ...base, startTime: "10:00" }).success).toBe(false);
    expect(ok({ ...base, endTime: "12:00" }).success).toBe(false);
    expect(ok({ ...base, startTime: "12:00", endTime: "10:00" }).success).toBe(false);
    expect(ok({ ...base, startTime: "10:00", endTime: "10:00" }).success).toBe(false);
    expect(ok({ ...base, startTime: "10:15", endTime: "12:00" }).success).toBe(false);
    expect(ok({ ...base, startTime: "10:00", endTime: "12:45" }).success).toBe(false);
    expect(ok({ ...base, startTime: "25:00", endTime: "26:00" }).success).toBe(false);
    expect(ok({ ...base, startTime: "10:00", endTime: "12:00", sessionIds: ["22222222-2222-4222-8222-222222222222"] }).success).toBe(false);
  });
  test("a RANGE body carries the same window", () => {
    expect(ok({ teacherId: base.teacherId, reason: "ธุระ", from: "2026-11-20", to: "2026-11-22", startTime: "10:00", endTime: "12:00" })).toMatchObject({ success: true, data: { date: "2026-11-20", to: "2026-11-22", startTime: "10:00", endTime: "12:00" } });
    expect(ok({ teacherId: base.teacherId, reason: "ธุระ", from: "2026-11-20", to: "2026-11-22", startTime: "10:00" }).success).toBe(false);
  });
  test("`workHours` on the work-days body: a subset of `workDays`, from < to, half-hours; null clears; absent = unchanged", () => {
    const p = (b: unknown) => setTeacherWorkDays.safeParse(b);
    expect(p({ workDays: [0, 6], workHours: { "0": ["13:00", "18:00"], "6": ["13:00", "18:00"] } })).toMatchObject({ success: true });
    expect(p({ workDays: [0, 6], workHours: null })).toMatchObject({ success: true, data: { workHours: null } });
    expect(p({ workDays: [0, 6] })).toMatchObject({ success: true });
    expect((p({ workDays: [0, 6] }) as any).data).not.toHaveProperty("workHours");
    expect(p({ workDays: [0], workHours: { "6": ["13:00", "18:00"] } }).success).toBe(false); // 6 is not a work day
    expect(p({ workDays: [6], workHours: { "6": ["18:00", "13:00"] } }).success).toBe(false);
    expect(p({ workDays: [6], workHours: { "6": ["13:10", "18:00"] } }).success).toBe(false);
    expect(p({ workDays: [6], workHours: { "7": ["13:00", "18:00"] } }).success).toBe(false);
    expect(p({ workDays: [6], workHours: { "6": ["13:00"] } }).success).toBe(false);
  });
  test("the impact query: `workHours` is an optional JSON string; bad JSON is a validation error, absent leaves today's query untouched", () => {
    expect(workDaysImpactQuery.safeParse({ workDays: "0,6" })).toMatchObject({ success: true, data: { workDays: [0, 6] } });
    expect((workDaysImpactQuery.safeParse({ workDays: "0,6" }) as any).data.workHours).toBeUndefined();
    expect(workDaysImpactQuery.safeParse({ workDays: "0,6", workHours: JSON.stringify({ "6": ["13:00", "18:00"] }) })).toMatchObject({ success: true, data: { workHours: { "6": ["13:00", "18:00"] } } });
    expect(workDaysImpactQuery.safeParse({ workDays: "0,6", workHours: "{nope" }).success).toBe(false);
    expect(workDaysImpactQuery.safeParse({ workDays: "0,6", workHours: JSON.stringify({ "6": ["18:00", "13:00"] }) }).success).toBe(false);
  });
});

describe("SPEC §3.4 — setting hours that orphan future classes WARNS (nothing is moved)", () => {
  test("`previewWorkDaysChange`: classes on a KEPT day outside the proposed window are listed; a class inside it, and a removed-day class, are counted once each; no hours sent = today's answer", async () => {
    setSystemTime(new Date(NOW));
    const { db } = await import("../db");
    const teacher = { id: T1, workDays: [0, 6], workHours: null };
    const cls = (id: string, date: string, startTime: string) => ({ id, date, startTime, endTime: startTime, status: "CONFIRMED", bookingType: "PRIVATE", teacherId: T1, teacher: { id: T1, nickname: "Ek", name: "Ek" }, student: null, subject: null });
    const rows = [cls("a", SAT, "10:00:00"), cls("b", SAT, "14:00:00"), cls("c", SUN, "09:00:00")];
    spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => teacher) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows) as any));
    const hours = await sched.previewWorkDaysChange(T1, [0, 6], { "6": ["13:00", "18:00"] });
    expect(hours.sessions.map((s: any) => s.id)).toEqual(["a"]); // Saturday 10:00 is outside 13–18; Saturday 14:00 fits; Sunday has no window
    expect(hours).toMatchObject({ orphanCount: 1, outsideHoursCount: 1 });
    const none = await sched.previewWorkDaysChange(T1, [0, 6]); // the old FE: workDays only
    expect(none).toEqual({ removedDays: [], removedDaysLabel: "", orphanCount: 0, sessions: [] });
    const dropSat = await sched.previewWorkDaysChange(T1, [0], { "0": ["08:00", "12:00"] });
    expect(dropSat.sessions.map((s: any) => s.id).sort()).toEqual(["a", "b"]); // both Saturday classes (a REMOVED day); Sunday 09:00 fits 08–12, so it is not listed
  });
});

describe("R1 — THE DOORS LIST (pinned): every door passes the class's time", () => {
  const S = read("src/services/scheduler.service.ts");
  test("`teacherLeaveOn(` call sites: every one in the services passes a time except the day-level camp sync (one question per day), each pinned by shape", () => {
    const C = code(S);
    expect([...C.matchAll(/teacherLeaveOn\(/g)].length).toBe(8); // the gate · «a teacher remains» · an extra coach on a group make-up · the course preview · Seam B · the start-date move · 🔻 TASK-969: the pattern make-up search (`pickPatternMakeupSlot`) · the pattern course's preview (`previewPatternCourse`) — both pass the row's OWN slot time
    for (const site of [
      "teacherLeaveOn(exec, teacher.id, date, opts.startTime)", // the gate (assertTeacherBookable)
      "teacherLeaveOn(exec, t.teacherId, c.date, c.startTime)", // «a teacher remains» (co-teaching)
      "teacherLeaveOn(tx, e, date, hhmm(t.startTime))", // an extra coach on a group make-up
      "teacherLeaveOn(db, input.teacherId, s.date, input.startTime)", // the course preview's flag
      "teacherLeaveOn(exec, teacherId, d, startTime)", // Seam B: the make-up search
      "teacherLeaveOn(tx, teacherId, date, startOfTeacher.get(teacherId))", // the start-date move
      "teacherLeaveOn(exec, occ.teacherId, occ.date, occ.startTime)", // 🔻 TASK-969: the pattern make-up search
      "teacherLeaveOn(db, teacherId, s.date, s.startTime)", // 🔻 TASK-969: the pattern course's preview
    ]) expect(C).toContain(site);
    const camp = read("src/services/camp.service.ts");
    expect(code(camp)).toContain("teacherLeaveOn(tx, c.teacherId, d.date)"); // 📌 day-level on purpose: a camp coach block spans the day; the part-day answer is "any row that day" (safe)
    expect(read("src/lib/teacher-leave.ts")).toContain("teacherLeaveOn(exec, coach.id, row.date, row.startTime)");
  });
  test("`assertTeacherBookable(` call sites: every one passes `startTime` (the moves read the NEW time when they change it)", () => {
    const sites = [...code(S).matchAll(/assertTeacherBookable\(([^;]*?)\);/gs)].map((m) => m[1]!.replace(/\s+/g, " ")).filter((s) => !/^exec: any/.test(s));
    expect(sites.length).toBe(12); // insertBooking ×2 · attach extras · group-coach swap ×2 · moveBooking · swap/move · plan swap · resume · start-date move · plan-move apply · moveRowToCoach
    for (const s of sites) expect({ s, passesTime: /startTime/.test(s) }).toEqual({ s, passesTime: true });
    expect(code(read("src/services/other-series.service.ts"))).toContain("{ allowSystem: !onExtra, startTime: r.startTime }");
  });
  test("a make-up writer never reaches the hours check as a refusal: `allowOutsideHours` is set in ONE place (`insertBooking`)", () => {
    expect([...code(S).matchAll(/allowOutsideHours/g)].length).toBe(4); // the opts type, the check, the two `insertBooking` calls — nowhere else
    expect(code(S)).toContain("allowOutsideHours: !!input.extendedFromId");
    expect(code(S)).toContain("allowOutsideHours: true");
  });
});

describe("the migration 0080 — additive, rerunnable, witnessed by the LAST statement", () => {
  const SQL = read("drizzle/0080_coach_time_ranges.sql");
  test("the text: two nullable time columns, the CHECK (both-or-neither, start < end), `teachers.work_hours` jsonb LAST; nothing destructive", () => {
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS "start_time" time');
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS "end_time" time');
    expect(SQL).toContain('DROP CONSTRAINT IF EXISTS "teacher_leave_days_time_ck"');
    expect(SQL).toContain('CHECK (("start_time" IS NULL AND "end_time" IS NULL) OR ("start_time" IS NOT NULL AND "end_time" IS NOT NULL AND "start_time" < "end_time"))');
    const stmts = SQL.split("--> statement-breakpoint").map((x) => x.replace(/^--.*$/gm, "").trim()).filter(Boolean);
    expect(stmts[stmts.length - 1]).toBe('ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "work_hours" jsonb;');
    expect(SQL.replace(/^--.*$/gm, "")).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE /i);
    expect(SQL.replace(/^--.*$/gm, "")).not.toMatch(/\bNOT NULL\b\s*(DEFAULT|;)/); // the new columns are nullable: every old row stays the whole day
  });
  test("the journal: idx 80, the tag, a `when` UNIQUE and the highest; the witness probes the LAST object", () => {
    const j = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const last = j.entries.find((e) => e.idx === 80)!; // 🔻 TASK-969: 0081 follows it
    expect(last).toMatchObject({ idx: 80, tag: "0080_coach_time_ranges" });
    const whens = j.entries.map((e) => e.when);
    expect(new Set(whens).size).toBe(whens.length);
    expect(last.when).toBe(Math.max(...j.entries.filter((e) => e.idx <= 80).map((e) => e.when)));
    expect(SCHEDULING_WITNESSES.find((w) => w.tag === "0080_coach_time_ranges")).toMatchObject({ probe: { kind: "column", table: "teachers", column: "work_hours" }, rerunnable: true });
  });
  test("the schema + the DTO + the contract carry the same names", () => {
    const schema = read("src/db/schema.ts");
    expect(schema).toContain('startTime: time("start_time"),');
    expect(schema).toContain('endTime: time("end_time"),');
    expect(schema).toContain('workHours: jsonb("work_hours").$type<Record<string, [string, string]>>(),');
    expect(read("src/db/mappers.ts")).toContain("workHours: t.workHours ?? null");
    const c = read("src/types/contract.ts");
    expect(c).toContain("workHours: Record<string, [string, string]> | null;");
    expect(c).toContain("startTime: string | null;\n  endTime: string | null;");
  });
  test("🚫 the LINE notice is UNCHANGED until Porter's Q1 is answered: no time in `teacher_leave_recorded` (SPEC §4)", () => {
    expect(read("src/lib/line-i18n.ts")).not.toMatch(/teacher_leave_recorded[^\n]*เวลา \{/);
    expect(code(read("src/services/scheduler.service.ts")).match(/kind: "teacher_leave_recorded"[^}]*startTime/)).toBeNull();
  });
});
