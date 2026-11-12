// TASK-959 (REQ-5013 option B, SPEC-105 §1 + §4) — a CLOSED DAY refuses new work on every placing door, and the make-up search steps over it.
//   · THE reader (`closedDayOn` / `assertDayOpen`) and THE refusal (`DAY_CLOSED`), by value;
//   · the block in `assertTeacherBookable` (SPEC §4.1): every coach, before the system-teacher return, today-or-later only, the two exemptions;
//   · the doors list (R1): every write that puts a booking on a date, each covered, pinned so a NEW door fails loudly;
//   · the make-up search (SPEC §4.3): a closed week reads as "not free", so the make-up lands one week later (preview = save: one function).
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { bookings, closedDays, teacherLeaveDays } from "../db/schema";
import * as sched from "../services/scheduler.service";
import { ApiException } from "./http";
import { assertDayOpen, closeFires, closedDayOn, closedReasonTh, DAY_CLOSED, openClosedDates, shortThaiDate } from "./closed-day";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const dialect = new PgDialect();
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });
const NOW = "2026-11-13T10:00:00+07:00"; // Bangkok Friday 13 Nov 2026
const T1 = "t1t1t1t1-t1t1-41t1-81t1-t1t1t1t1t1t1";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Closed = { date: string; reason: string; note?: string | null; reopenedAt?: Date | null };
/** An exec whose three reads are answered by evaluating the REAL where-clauses (real tables, real operators) and reading the parameters they carry. */
function execOf(o: { closed?: Closed[]; leave?: string[]; taken?: string[]; teacher?: any; calls?: string[] } = {}) {
  const paramsOf = (cond: any) => dialect.sqlToQuery(cond).params as unknown[];
  const dateOf = (cond: any) => paramsOf(cond).find((p) => typeof p === "string" && DATE.test(p)) as string | undefined;
  const calls = o.calls ?? [];
  const exec: any = {
    query: {
      teachers: { findFirst: async () => o.teacher ?? { id: T1, nickname: "Ek", archived: false, isSystem: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME" } },
      closedDays: { findFirst: async (q: any) => { calls.push("closedDays"); const d = dateOf(q.where(closedDays, { and, eq, isNull })); return (o.closed ?? []).find((r) => r.date === d && !r.reopenedAt); } },
      teacherLeaveDays: { findFirst: async (q: any) => { calls.push("teacherLeaveDays"); const d = dateOf(q.where(teacherLeaveDays, { and, eq })); return d && o.leave?.includes(d) ? { id: "l" } : undefined; } },
      bookings: { findFirst: async (q: any) => { calls.push("bookings"); const d = dateOf(q.where(bookings, { and, eq, notInArray })); return d && o.taken?.includes(d) ? { id: "b" } : undefined; } },
    },
  };
  return exec;
}
const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof ApiException) return { status: e.status, code: e.code, message: e.message }; throw e; } return null; };

describe("the words: `DAY_CLOSED` is a 409 with SPEC-105 §3's sentence", () => {
  test("`วันที่ {d MMM} ปิดทำการ ({reason TH}) — กรุณาเลือกวันอื่น`, each reason's Thai word, OTHER = the note", () => {
    const m = (reason: string, note?: string | null) => (DAY_CLOSED("2026-11-20", reason, note) as ApiException);
    expect(m("HOLIDAY")).toMatchObject({ status: 409, code: "DAY_CLOSED", message: "วันที่ 20 พ.ย. ปิดทำการ (วันหยุด) — กรุณาเลือกวันอื่น" });
    expect(m("VENUE_CLOSED").message).toBe("วันที่ 20 พ.ย. ปิดทำการ (สถานที่ปิด) — กรุณาเลือกวันอื่น");
    expect(m("WEATHER").message).toBe("วันที่ 20 พ.ย. ปิดทำการ (สภาพอากาศ) — กรุณาเลือกวันอื่น");
    expect(m("OTHER", "  งานกีฬาสี ").message).toBe("วันที่ 20 พ.ย. ปิดทำการ (งานกีฬาสี) — กรุณาเลือกวันอื่น");
  });
  test("the date reads `d MMM` for every month (no leading zero, the Thai abbreviation)", () => {
    expect(["2026-01-05", "2026-02-09", "2026-03-31", "2026-04-13", "2026-05-01", "2026-06-02", "2026-07-03", "2026-08-12", "2026-09-30", "2026-10-07", "2026-11-13", "2026-12-25"].map(shortThaiDate)).toEqual([
      "5 ม.ค.", "9 ก.พ.", "31 มี.ค.", "13 เม.ย.", "1 พ.ค.", "2 มิ.ย.", "3 ก.ค.", "12 ส.ค.", "30 ก.ย.", "7 ต.ค.", "13 พ.ย.", "25 ธ.ค.",
    ]);
    expect(closedReasonTh("HOLIDAY")).toBe("วันหยุด");
    expect(closedReasonTh("OTHER", null)).toBe("");
  });
  test("`closeFires`: today or later only — a back-dated write never meets a closed day", () => {
    expect([closeFires("2026-11-14", "2026-11-13"), closeFires("2026-11-13", "2026-11-13"), closeFires("2026-11-12", "2026-11-13")]).toEqual([true, true, false]);
  });
});

describe("THE reader: `closedDayOn` reads OPEN rows only; `assertDayOpen` refuses today or later", () => {
  test("an open row is found; a RE-OPENED one is history, never a block; no row ⇒ null", async () => {
    const exec = execOf({ closed: [{ date: "2026-11-20", reason: "HOLIDAY" }, { date: "2026-11-21", reason: "HOLIDAY", reopenedAt: new Date() }] });
    expect(await closedDayOn(exec, "2026-11-20")).toMatchObject({ date: "2026-11-20" });
    expect(await closedDayOn(exec, "2026-11-21")).toBeNull();
    expect(await closedDayOn(exec, "2026-11-22")).toBeNull();
  });
  test("the query itself asks for `reopened_at IS NULL` (so the real database never returns a re-opened row)", async () => {
    let seen = "";
    const exec: any = { query: { closedDays: { findFirst: async (q: any) => { seen = dialect.sqlToQuery(q.where(closedDays, { and, eq, isNull })).sql; return undefined; } } } };
    await closedDayOn(exec, "2026-11-20");
    expect(seen).toContain('"closed_days"."reopened_at" is null');
    expect(seen).toContain('"closed_days"."date" = $1');
  });
  test("`assertDayOpen`: refuses a FUTURE and TODAY closed date (409 DAY_CLOSED), lets a PAST one through WITHOUT even asking the table", async () => {
    setSystemTime(new Date(NOW));
    const calls: string[] = [];
    const exec = execOf({ closed: [{ date: "2026-11-20", reason: "WEATHER" }, { date: "2026-11-13", reason: "HOLIDAY" }, { date: "2026-11-12", reason: "HOLIDAY" }], calls });
    expect(await refusal(assertDayOpen(exec, "2026-11-20"))).toMatchObject({ status: 409, code: "DAY_CLOSED", message: "วันที่ 20 พ.ย. ปิดทำการ (สภาพอากาศ) — กรุณาเลือกวันอื่น" });
    expect(await refusal(assertDayOpen(exec, "2026-11-13"))).toMatchObject({ code: "DAY_CLOSED" }); // today is closed too
    calls.length = 0;
    expect(await refusal(assertDayOpen(exec, "2026-11-12"))).toBeNull(); // yesterday: a back-dated write passes
    expect(calls).toEqual([]);
    expect(await refusal(assertDayOpen(exec, "2026-11-30"))).toBeNull(); // an open day
  });
  test("`openClosedDates`: ONE query for a whole horizon, none for an empty list", async () => {
    let calls = 0;
    const exec: any = { select: () => ({ from: () => ({ where: async () => { calls++; return [{ date: "2026-11-27" }]; } }) }) };
    expect([...(await openClosedDates(exec, ["2026-11-20", "2026-11-27"]))]).toEqual(["2026-11-27"]);
    expect(calls).toBe(1);
    expect((await openClosedDates(exec, [])).size).toBe(0);
    expect(calls).toBe(1);
  });
});

describe("SPEC §4.1 — the block in `assertTeacherBookable`: every coach, FIRST, before the system-teacher return", () => {
  test("a future closed day ⇒ 409 DAY_CLOSED for an ordinary coach; an open day passes and returns the teacher", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf({ closed: [{ date: "2026-11-20", reason: "HOLIDAY" }] });
    expect(await refusal(sched.assertTeacherBookable(exec, T1, "2026-11-20"))).toMatchObject({ status: 409, code: "DAY_CLOSED" });
    expect(await sched.assertTeacherBookable(exec, T1, "2026-11-21")).toMatchObject({ id: T1 });
  });
  test("🔑 an OTHER on «No Teacher» is refused too (the block is BEFORE the system-teacher early return); the open day still lets it through", async () => {
    setSystemTime(new Date(NOW));
    const sys = { id: "sys", nickname: "No Teacher", isSystem: true, archived: false, workDays: [], type: "FREELANCE" };
    const exec = execOf({ teacher: sys, closed: [{ date: "2026-11-20", reason: "VENUE_CLOSED" }] });
    expect(await refusal(sched.assertTeacherBookable(exec, "sys", "2026-11-20", { allowSystem: true }))).toMatchObject({ status: 409, code: "DAY_CLOSED" });
    expect(await sched.assertTeacherBookable(exec, "sys", "2026-11-21", { allowSystem: true })).toMatchObject({ id: "sys" });
    // …and the system teacher's own refusal order is unchanged on an open day: not allowed ⇒ the same error as before
    expect(await refusal(sched.assertTeacherBookable(exec, "sys", "2026-11-21"))).toMatchObject({ code: "SYSTEM_TEACHER_NOT_BOOKABLE" });
  });
  test("the block is for EVERY coach (it reads the date, never the teacher): another coach on the same date is refused the same way", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf({ closed: [{ date: "2026-11-20", reason: "HOLIDAY" }], teacher: { id: "t2", nickname: "Nok", archived: false, isSystem: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME" } });
    expect(await refusal(sched.assertTeacherBookable(exec, "t2", "2026-11-20"))).toMatchObject({ code: "DAY_CLOSED" });
  });
  test("a back-dated write passes (as with leave); TODAY is blocked; a re-opened day passes", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf({ closed: [{ date: "2026-11-12", reason: "HOLIDAY" }, { date: "2026-11-13", reason: "HOLIDAY" }, { date: "2026-11-25", reason: "HOLIDAY", reopenedAt: new Date() }] });
    expect(await sched.assertTeacherBookable(exec, T1, "2026-11-12")).toMatchObject({ id: T1 });
    expect(await refusal(sched.assertTeacherBookable(exec, T1, "2026-11-13"))).toMatchObject({ code: "DAY_CLOSED" });
    expect(await sched.assertTeacherBookable(exec, T1, "2026-11-25")).toMatchObject({ id: T1 });
  });
  test("a missing coach is still «ไม่พบครู» first (the closed-day read comes after the teacher exists)", async () => {
    setSystemTime(new Date(NOW));
    const calls: string[] = [];
    const exec = execOf({ closed: [{ date: "2026-11-20", reason: "HOLIDAY" }], calls });
    exec.query.teachers.findFirst = async () => undefined;
    expect(await refusal(sched.assertTeacherBookable(exec, "nobody", "2026-11-20"))).toMatchObject({ status: 400, message: "ไม่พบครู" });
    expect(calls).toEqual([]);
  });
  test("`allowClosedDay` skips THIS check and nothing else: an archived coach is still refused; the coach's own leave still blocks", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf({ closed: [{ date: "2026-11-20", reason: "HOLIDAY" }] });
    expect(await sched.assertTeacherBookable(exec, T1, "2026-11-20", { allowClosedDay: true })).toMatchObject({ id: T1 });
    const archived = execOf({ closed: [{ date: "2026-11-20", reason: "HOLIDAY" }], teacher: { id: T1, nickname: "Ek", archived: true, isSystem: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME" } });
    expect(await refusal(sched.assertTeacherBookable(archived, T1, "2026-11-20", { allowClosedDay: true }))).toMatchObject({ status: 400 });
    const onLeave = execOf({ closed: [{ date: "2026-11-20", reason: "HOLIDAY" }], leave: ["2026-11-20"] });
    expect(await refusal(sched.assertTeacherBookable(onLeave, T1, "2026-11-20", { allowClosedDay: true }))).toMatchObject({ code: "TEACHER_ON_LEAVE" });
  });
  test("the closed day is judged BEFORE the coach's leave (the school-wide fact first): both ⇒ DAY_CLOSED", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf({ closed: [{ date: "2026-11-20", reason: "HOLIDAY" }], leave: ["2026-11-20"] });
    expect(await refusal(sched.assertTeacherBookable(exec, T1, "2026-11-20"))).toMatchObject({ code: "DAY_CLOSED" });
  });
});

describe("SPEC §4.1 — `insertBooking` passes the exemption ONLY for a planned absence and the camp sync's rows", () => {
  /** stop `insertBooking` right after its gate, capturing what it asked `assertTeacherBookable`. */
  async function opts(input: any) {
    const seen: any[] = [];
    spies.push(spyOn(sched, "assertTeacherBookable").mockImplementation((async (_e: any, _t: string, _d: string, o: any) => { seen.push(o); throw new Error("STOP"); }) as any));
    try { await sched.insertBooking({} as any, null, { teacherId: T1, subjectId: null, date: "2026-11-20", startTime: "10:00", ...input }); } catch (e: any) { if (e.message !== "STOP") throw e; }
    for (const s of spies.splice(0)) s.mockRestore();
    return seen[0];
  }
  test("a normal class / a voucher session / a course week / a trial: NOT exempt", async () => {
    for (const bookingType of ["SINGLE_SESSION", "VOUCHER", "COURSE_PACKAGE", "FIRST_TRIAL"]) {
      expect((await opts({ bookingType, status: "CONFIRMED" })).allowClosedDay).toBe(false);
      expect((await opts({ bookingType })).allowClosedDay).toBe(false);
    }
  });
  test("a PLANNED ABSENCE (SICK_LEAVE + plannedAtCreation) IS exempt, and still gets the leave exemption; a SICK_LEAVE that is NOT planned is not", async () => {
    expect(await opts({ bookingType: "COURSE_PACKAGE", status: "SICK_LEAVE", plannedAtCreation: true })).toMatchObject({ allowClosedDay: true, allowLeave: true });
    expect((await opts({ bookingType: "COURSE_PACKAGE", status: "SICK_LEAVE", plannedAtCreation: false })).allowClosedDay).toBe(false);
    expect((await opts({ bookingType: "COURSE_PACKAGE", status: "SICK_LEAVE" })).allowClosedDay).toBe(false);
  });
  test("the CAMP sync's rows (an OTHER of kind CAMP) are exempt; any other OTHER, a GROUP row (the extender's) and a camp-kind row of another type are NOT", async () => {
    expect((await opts({ bookingType: "OTHER", otherKind: "CAMP", status: "CONFIRMED" })).allowClosedDay).toBe(true);
    expect((await opts({ bookingType: "OTHER", otherKind: "RENT" })).allowClosedDay).toBe(false);
    expect((await opts({ bookingType: "OTHER" })).allowClosedDay).toBe(false);
    expect((await opts({ bookingType: "GROUP", otherKind: "GROUP" })).allowClosedDay).toBe(false);
    expect((await opts({ bookingType: "SINGLE_SESSION", otherKind: "CAMP" })).allowClosedDay).toBe(false);
  });
  test("BY VALUE through the real `insertBooking`: a class onto a closed day is refused 409 DAY_CLOSED BEFORE any write (single · voucher · course week), and the camp row / planned absence go past the gate", async () => {
    setSystemTime(new Date(NOW));
    const writes: string[] = [];
    const exec = execOf({ closed: [{ date: "2026-11-20", reason: "HOLIDAY" }] });
    exec.insert = () => { writes.push("insert"); throw new Error("must not be reached"); };
    exec.update = () => { writes.push("update"); throw new Error("must not be reached"); };
    for (const bookingType of ["SINGLE_SESSION", "VOUCHER", "COURSE_PACKAGE"]) {
      const r = await refusal(sched.insertBooking(exec, "s1", { teacherId: T1, subjectId: "sub", date: "2026-11-20", startTime: "10:00", bookingType, status: "CONFIRMED" }));
      expect({ bookingType, ...r }).toMatchObject({ bookingType, status: 409, code: "DAY_CLOSED" });
    }
    expect(writes).toEqual([]);
    // the exempt rows are NOT refused by the closed-day gate (anything they hit later is another rule's)
    for (const input of [{ bookingType: "OTHER", otherKind: "CAMP", status: "CONFIRMED" }, { bookingType: "COURSE_PACKAGE", status: "SICK_LEAVE", plannedAtCreation: true }]) {
      let err: any = null;
      try { await sched.insertBooking(exec, "s1", { teacherId: T1, subjectId: "sub", date: "2026-11-20", startTime: "10:00", ...input }); } catch (e) { err = e; }
      expect(err?.code).not.toBe("DAY_CLOSED");
    }
  });
});

describe("R1 — THE DOORS LIST: every write that puts a booking on a date, and how each is covered (pinned: a NEW door fails here)", () => {
  const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
  const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(d, e.name)] : []));
  const SRC = walk(join(root, "src")).map((f) => [f.slice(root.length + 1).replace(/\\/g, "/"), code(readFileSync(f, "utf8").replace(/\r\n/g, "\n"))] as const);
  const count = (re: RegExp) => Object.fromEntries(SRC.map(([f, s]) => [f, (s.match(re) ?? []).length]).filter(([, n]) => (n as number) > 0));

  test("`assertTeacherBookable(` is called from EXACTLY these places (the gate every move / swap / co-teacher / plan-move / cover / resume door shares)", () => {
    expect(count(/\bassertTeacherBookable\(/g)).toEqual({
      "src/services/scheduler.service.ts": 13, /* 🔻 TASK-961: + `moveRowToCoach` (the activity change's coach move — the coach only, never a date) */ // the definition + insertBooking ×2 (planned absence / normal) + attachAdditionalTeachers + moveGroupRowToTeacher + the swap/move door + the group-coach swap + the plan swap + moveBooking + the plan-move apply + the course plan-move apply (+ resume, only for a CHANGED coach: its own explicit check covers the unchanged one)
      "src/services/other-series.service.ts": 1, // the series COVER (an OTHER / group series' coach swap)
    });
  });
  test("every write of a booking's DATE or a new booking row is accounted for: the ONE inserter, the two make-up writers (their date comes from the closed-day-aware search), the plan-move applies, and the dev seed", () => {
    expect(count(/\.insert\(bookings\)/g)).toEqual({
      "src/db/seed.ts": 1, // dev seed, never in a request
      "src/services/scheduler.service.ts": 3, // `insertBooking` (guarded) + the re-plan append + the leave's make-up (both dated by `findFreeExtensionDate`)
    });
    const S = code(read("src/services/scheduler.service.ts"));
    expect([...S.matchAll(/findFreeExtensionDate\(tx, /g)].length).toBeGreaterThanOrEqual(2); // both make-up writers search through the ONE function
    // the plan-move applies assert per moved session whose date changes
    expect(S).toContain("if (m.from !== m.to) await assertTeacherBookable(tx, m.teacherId, m.to, { startTime: startOfRow.get(m.id) });");
    expect(S).toContain("await assertTeacherBookable(tx, m.to.teacherId, m.to.date, { startTime: m.to.startTime });");
    // a single-session move / swap asserts the NEW date and teacher (`patch.date ?? current.date`)
    expect(S).toContain("patch.teacherId ?? current.teacherId,\n        patch.date ?? current.date,");
  });
  test("the camp sync inserts through the ONE inserter (so its exemption is the ONE place, `otherKind === CAMP_KIND`) and writes no other booking row", () => {
    const C = code(read("src/services/camp.service.ts"));
    expect([...C.matchAll(/insertBooking\(/g)].length).toBe(1); // the sync's ONE call (the import line has no paren)
    expect(C).toContain('otherKind: CAMP_KIND');
    expect(code(read("src/services/scheduler.service.ts"))).toContain('input.bookingType === "OTHER" && input.otherKind === CAMP_KIND');
  });
  test("the group-series extender inserts through `insertBooking` too (its backstop), and the extender skips closed days BEFORE it", () => {
    const J = code(read("src/services/jobs.service.ts"));
    expect(J).toContain("const shut = await openClosedDates(db, wanted);");
    expect(J).toContain("closedDaySkipped += wanted.length - dates.length;");
    expect(J).toContain("const id = await insertBooking(tx, null, {");
  });
  test("RESUMING a paused class is a placement that does NOT always meet `assertTeacherBookable` (same coach): the explicit check is in `resumeBooking`, before the coach check", () => {
    const S = code(read("src/services/scheduler.service.ts"));
    const body = S.slice(S.indexOf("export async function resumeBooking("), S.indexOf("\n}\n", S.indexOf("export async function resumeBooking(")));
    expect(body).toContain("await assertDayOpen(tx, input.date);");
    expect(body.indexOf("await assertDayOpen(tx, input.date);")).toBeLessThan(body.indexOf("assertTeacherBookable("));
  });
  test("status changes are NOT placements (SPEC §4.5): attend / cancel / sick-leave / confirm never call the closed-day check", () => {
    const S = code(read("src/services/scheduler.service.ts"));
    const upd = S.slice(S.indexOf("export async function updateBookingStatus("), S.indexOf("\n}\n", S.indexOf("export async function updateBookingStatus(")));
    expect(upd).not.toContain("assertDayOpen");
    expect(upd).not.toContain("closedDayOn");
    // the ONLY users of the reader outside its own lib: the gate, resume, the make-up search
    expect(count(/\b(assertDayOpen|closedDayOn)\(/g)).toEqual({ "src/lib/closed-day.ts": 3, "src/services/scheduler.service.ts": 3 }); // the lib: the two definitions + `assertDayOpen`'s own call of the reader · the service: the gate, resume, the make-up search
  });
  test("BY VALUE, `moveBooking`: moving a class ONTO a closed day is refused 409 DAY_CLOSED and writes nothing; onto an open day it is not refused by the gate", async () => {
    setSystemTime(new Date(NOW));
    const { db } = await import("../db");
    const writes: string[] = [];
    const row: any = { id: "B1", status: "CONFIRMED", date: "2026-11-18", startTime: "10:00:00", endTime: "11:00:00", teacherId: T1, studentId: "s1", coStudentId: null, courseId: null, voucherId: null, bookingType: "SINGLE_SESSION", groupId: null, note: null, campWeekDayId: null };
    const exec = execOf({ closed: [{ date: "2026-11-20", reason: "HOLIDAY" }] });
    exec.query.bookings.findFirst = async () => ({ ...row, course: null, voucher: null });
    exec.update = () => { writes.push("update"); return { set: () => ({ where: async () => {} }) }; };
    exec.insert = () => { writes.push("insert"); throw new Error("no insert"); };
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => ({ ...row })) as any));
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(exec)) as any));
    spies.push(spyOn(sched, "assertBookingCourseWritable").mockImplementation((async () => {}) as any));
    const r = await refusal(sched.moveBooking("B1", { date: "2026-11-20" }));
    expect(r).toMatchObject({ status: 409, code: "DAY_CLOSED" });
    expect(writes).toEqual([]);
    let other: any = null;
    try { await sched.moveBooking("B1", { date: "2026-11-21" }); } catch (e) { other = e; }
    expect(other?.code).not.toBe("DAY_CLOSED");
  });
  test("BY VALUE, `resumeBooking`: putting a PAUSED class back onto a closed day is refused 409 DAY_CLOSED even with the SAME coach, and nothing is written", async () => {
    setSystemTime(new Date(NOW));
    const { db } = await import("../db");
    const writes: string[] = [];
    const row: any = { id: "P1", status: "PAUSED", date: "2026-11-18", startTime: "10:00:00", teacherId: T1, studentId: "s1", bookingType: "SINGLE_SESSION", courseId: null, voucherId: null, groupId: null, campWeekDayId: null };
    const exec = execOf({ closed: [{ date: "2026-11-20", reason: "WEATHER" }] });
    exec.query.bookings.findFirst = async () => ({ ...row });
    exec.update = () => { writes.push("update"); return { set: () => ({ where: async () => {} }) }; };
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(exec)) as any));
    const r = await refusal(sched.resumeBooking("P1", { date: "2026-11-20", startTime: "10:00" }));
    expect(r).toMatchObject({ status: 409, code: "DAY_CLOSED", message: "วันที่ 20 พ.ย. ปิดทำการ (สภาพอากาศ) — กรุณาเลือกวันอื่น" });
    expect(writes).toEqual([]);
  });
});

describe("SPEC §4.3 — the make-up search steps over a closed day (Seam B): the make-up lands one week later, never refused", () => {
  const free = (exec: any, from: string, teacher = T1) => sched.findFreeExtensionDate(exec, teacher, "10:00:00", from);
  test("the next free week is closed ⇒ the make-up lands ONE WEEK LATER; two closed weeks in a row ⇒ two weeks later", async () => {
    setSystemTime(new Date(NOW));
    expect(await free(execOf({}), "2026-11-20")).toBe("2026-11-27"); // nothing closed: from + 7
    expect(await free(execOf({ closed: [{ date: "2026-11-27", reason: "HOLIDAY" }] }), "2026-11-20")).toBe("2026-12-04");
    expect(await free(execOf({ closed: [{ date: "2026-11-27", reason: "HOLIDAY" }, { date: "2026-12-04", reason: "WEATHER" }] }), "2026-11-20")).toBe("2026-12-11");
  });
  test("it reads as `not free` for EVERY coach (the school is shut), unlike a coach's own leave", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf({ closed: [{ date: "2026-11-27", reason: "HOLIDAY" }] });
    expect(await free(exec, "2026-11-20", T1)).toBe("2026-12-04");
    expect(await free(exec, "2026-11-20", "another-coach")).toBe("2026-12-04");
  });
  test("a RE-OPENED day is free again; a closed day that is not the candidate changes nothing", async () => {
    setSystemTime(new Date(NOW));
    expect(await free(execOf({ closed: [{ date: "2026-11-27", reason: "HOLIDAY", reopenedAt: new Date() }] }), "2026-11-20")).toBe("2026-11-27");
    expect(await free(execOf({ closed: [{ date: "2026-11-28", reason: "HOLIDAY" }] }), "2026-11-20")).toBe("2026-11-27");
  });
  test("it composes with a taken slot and a coach's leave: the first date that is open, free and un-leaved", async () => {
    setSystemTime(new Date(NOW));
    const exec = execOf({ closed: [{ date: "2026-11-27", reason: "HOLIDAY" }], leave: ["2026-12-04"], taken: ["2026-12-11"] });
    expect(await free(exec, "2026-11-20")).toBe("2026-12-18");
  });
  test("a BACK-DATED candidate is never judged closed (the block fires from today on)", async () => {
    setSystemTime(new Date(NOW));
    const calls: string[] = [];
    expect(await free(execOf({ closed: [{ date: "2026-10-09", reason: "HOLIDAY" }], calls }), "2026-10-02")).toBe("2026-10-09");
    expect(calls).not.toContain("closedDays");
  });
  test("the dates this run already claimed (the PREVIEW's `alreadyTaken`) still win first", async () => {
    setSystemTime(new Date(NOW));
    expect(await sched.findFreeExtensionDate(execOf({}), T1, "10:00:00", "2026-11-20", new Set(["2026-11-27"]))).toBe("2026-12-04");
  });
  test("preview = save: both make-up writers AND the preview search through the ONE function; no second copy of the rule", () => {
    const S = readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect([...S.matchAll(/findFreeExtensionDate\(/g)].length).toBeGreaterThanOrEqual(4); // the definition + the re-plan append + the leave's make-up + the preview
    expect(S).toContain("if (closeFires(d, bangkokNow().date) && (await closedDayOn(exec, d))) return true;");
    expect(S).not.toMatch(/closedDays\.findFirst|query\.closedDays/); // the service never reads the table itself: `closedDayOn` is the ONE reader
  });
});
