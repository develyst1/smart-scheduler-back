// TASK-838 (REQ-127 "เปลี่ยนครู / เวลา ทั้งคอร์ส") — the REST of a course moves to a new teacher, day and time, in ONE act. By value through the REAL service with a fake transaction that really ROLLS BACK (writes are journalled
// and discarded on any throw): 10 sessions with 6 delivered ⇒ the 4 live ones move, the 6 delivered are untouched; ONE notice per coach (not 4 + 4); a clash ⇒ 409 `SLOT_TAKEN` naming the date and 0 rows changed; the preview writes
// nothing and equals the act; an ended course refuses; the expiry only grows.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import { bookings, coursePackages } from "../db/schema";
import * as lineLib from "./line";
import * as sched from "../services/scheduler.service";
import { formatOutboxMessage } from "./line-message";
import { courseSessionDates } from "./recurring";
import { isTeacherTimeRefusal, planCourseTeacherTimeChange } from "./course-teacher-time-change";
import { ROUTE_ACCESS } from "./route-access";

const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const dialect = new PgDialect();
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const COURSE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T1 = "11111111-1111-4111-8111-111111111111"; // the old coach
const T2 = "22222222-2222-4222-8222-222222222222"; // the new coach
const NEW_START = "2099-04-06"; // a Monday, far ahead — "today or later" holds whatever today is
const NEW_TIME = "15:00";

type Row = { id: string; date: string; startTime: string; endTime: string; status: string; teacherId: string; bookingType: string };
const delivered = (i: number): Row => ({ id: `d${i}`, date: `2020-01-${String(i + 1).padStart(2, "0")}`, startTime: "10:00:00", endTime: "11:00:00", status: "ATTENDED", teacherId: T1, bookingType: "COURSE_PACKAGE" });
const live = (id: string, date: string, status: string, teacherId = T1): Row => ({ id, date, startTime: "10:00:00", endTime: "11:00:00", status, teacherId, bookingType: "COURSE_PACKAGE" });
/** 10 sessions: 6 delivered + 1 CONFIRMED + 3 PENDING (the TASK's example). */
const tenSessions = (): Row[] => [
  ...[0, 1, 2, 3, 4, 5].map(delivered),
  live("c1", "2099-03-02", "CONFIRMED"),
  live("p1", "2099-03-09", "PENDING"),
  live("p2", "2099-03-16", "PENDING"),
  live("p3", "2099-03-23", "PENDING"),
];

type World = { course: any; rows: Row[]; journal: any[]; committed: any[]; outbox: any[]; clashOn?: number; expiryRecords: any[] };
const world = (rows: Row[], course: Partial<any> = {}, clashOn?: number): World => ({ course: { id: COURSE, size: 10, endedAt: null, droppedAt: null, expiryDate: "2099-04-01", ...course }, rows, journal: [], committed: [], outbox: [], clashOn, expiryRecords: [] });
const idsIn = (w: any): string[] => dialect.sqlToQuery(w).params.map(String);

function arm(w: World) {
  const known = new Set(w.rows.map((r) => r.id));
  const tx = {
    query: {
      coursePackages: { findFirst: async () => w.course },
      bookings: { findMany: async () => w.rows },
      teachers: { findFirst: async (o: any) => { const id = o.where({ id: "x" }, { eq: (_a: any, b: any) => b }); return { id, nickname: id === T1 ? "Old" : "New", lineUserId: `U-${id.slice(0, 4)}`, archived: false }; } },
    },
    update: (table: any) => ({
      set: (v: any) => ({
        where: async (cond: any) => {
          const id = table === bookings ? idsIn(cond).find((p) => known.has(p)) : COURSE;
          const n = w.journal.filter((j) => j.table === "bookings").length;
          if (table === bookings && w.clashOn !== undefined && n + 1 === w.clashOn) throw Object.assign(new Error("duplicate key"), { code: "23505" });
          w.journal.push({ table: table === bookings ? "bookings" : table === coursePackages ? "course_packages" : "other", id, v });
        },
      }),
    }),
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (cb: any) => {
    const mark = w.journal.length, outMark = w.outbox.length;
    try { const r = await cb(tx); w.committed.push(...w.journal.slice(mark)); return r; }
    catch (e) { w.journal.length = mark; w.outbox.length = outMark; throw e; } // a REAL rollback: nothing the failed act wrote survives
  }) as any));
  spies.push(spyOn(sched, "assertTeacherBookable").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(sched, "recordExpiryChange").mockImplementation((async (_tx: any, o: any) => { w.expiryRecords.push(o); }) as any));
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { w.outbox.push(o); return { status: "queued" } as any; }) as any));
}
const input = (teacherId = T2) => ({ teacherId, startDate: NEW_START, startTime: NEW_TIME });
const bookingWrites = (w: World) => w.committed.filter((j) => j.table === "bookings");

describe("🔴 the act — a 10-session course with 6 delivered, 1 CONFIRMED + 3 PENDING left", () => {
  test("those 4 move to the new teacher / day / time (the planner's dates, one per row, in order), the CONFIRMED one returns to PENDING, the 6 delivered are NOT written", async () => {
    const w = world(tenSessions());
    arm(w);
    const r: any = await sched.changeCourseTeacherAndTime(COURSE, input(), "admin");
    const dates = courseSessionDates(NEW_START, 4);
    expect(r).toMatchObject({ n: 4, moved: 4, firstDate: dates[0], lastDate: dates[3], teacherId: T2, needsReconfirm: 1 });
    const writes = bookingWrites(w);
    expect(writes.map((x) => x.id).sort()).toEqual(["c1", "p1", "p2", "p3"]); // never d0…d5
    for (const x of writes) expect(x.v).toMatchObject({ teacherId: T2, startTime: NEW_TIME, endTime: "16:00" });
    const byRow = new Map(writes.map((x) => [x.id, x.v]));
    expect(["c1", "p1", "p2", "p3"].map((id) => byRow.get(id).date)).toEqual(dates); // one new date per moved row, in the rows' own order
    expect(byRow.get("c1")).toMatchObject({ status: "PENDING", confirmedAt: null, checkinToken: null, checkinTokenExpiresAt: null });
    for (const id of ["p1", "p2", "p3"]) expect(byRow.get(id)).not.toHaveProperty("status"); // a PENDING row keeps its status
    expect(w.committed.filter((j) => j.table === "course_packages")).toHaveLength(1);
    expect(w.committed.find((j) => j.table === "course_packages")!.v).toMatchObject({ startTime: NEW_TIME });
  });
  test("🔴 not a pause and not a cancel: nothing is cancelled, no `droppedAt`, the counters and the sale are untouched", async () => {
    const w = world(tenSessions());
    arm(w);
    await sched.changeCourseTeacherAndTime(COURSE, input(), "admin");
    const all = JSON.stringify(w.committed);
    expect(all).not.toContain("CANCELLED");
    expect(all).not.toContain("droppedAt");
    for (const f of ["usedSessions", "leaveUsed", "size", "priorSessions"]) expect(all).not.toContain(f);
  });
  test("ONE notice per coach per act: exactly 2 outbox rows (the old coach's 4 sessions at their OLD slot in ONE message, the new coach's 4 at their NEW slot in ONE) — not 4 + 4", async () => {
    const w = world(tenSessions());
    arm(w);
    await sched.changeCourseTeacherAndTime(COURSE, input(), "admin");
    expect(w.outbox).toHaveLength(2);
    const [oldN, newN] = w.outbox;
    expect(oldN).toMatchObject({ recipientType: "teacher", payload: { kind: "teacher_unassigned" } });
    expect(newN).toMatchObject({ recipientType: "teacher", payload: { kind: "teacher_assigned" } });
    expect(oldN.recipientLineUserId).toBe("U-1111");
    expect(newN.recipientLineUserId).toBe("U-2222");
    expect(oldN.payload.sessions).toEqual([
      { date: "2099-03-02", startTime: "10:00", endTime: "11:00" }, { date: "2099-03-09", startTime: "10:00", endTime: "11:00" },
      { date: "2099-03-16", startTime: "10:00", endTime: "11:00" }, { date: "2099-03-23", startTime: "10:00", endTime: "11:00" },
    ]); // the OLD coach is shown what he LOSES, at the OLD times
    const dates = courseSessionDates(NEW_START, 4);
    expect(newN.payload.sessions).toEqual(dates.map((d) => ({ date: d, startTime: "15:00", endTime: "16:00" }))); // the NEW coach at the NEW times
  });
  test("the same coach (a time-only change) ⇒ the rows move, NO coach notice and NO family message (the schedule message comes at «ยืนยันทั้งคอร์ส»)", async () => {
    const w = world(tenSessions());
    arm(w);
    const r: any = await sched.changeCourseTeacherAndTime(COURSE, input(T1), "admin");
    expect(r.n).toBe(4);
    expect(bookingWrites(w)).toHaveLength(4);
    expect(w.outbox).toEqual([]);
  });
  test("🔴 a clash with ANOTHER booking on the 3rd date ⇒ 409 SLOT_TAKEN naming that date, and 0 rows changed (all-or-nothing)", async () => {
    const w = world(tenSessions(), {}, 3);
    arm(w);
    const dates = courseSessionDates(NEW_START, 4);
    const order = planCourseTeacherTimeChange(w.rows, input(), "2000-01-01") as any;
    const third = order.moves.find((m: any) => m.id === order.order[2]).to.date;
    await expect(sched.changeCourseTeacherAndTime(COURSE, input(), "admin")).rejects.toMatchObject({ status: 409, code: "SLOT_TAKEN" });
    await expect(sched.changeCourseTeacherAndTime(COURSE, input(), "admin")).rejects.toThrow(third);
    expect(dates).toContain(third);
    expect(w.committed).toEqual([]); // nothing survived, not even the first two rows' writes
    expect(w.journal).toEqual([]);
    expect(w.outbox).toEqual([]); // …and no notice
  });
  test("an ENDED course ⇒ refused with its own words (COURSE_ENDED), 0 writes; a PAUSED one ⇒ COURSE_DROPPED", async () => {
    for (const [course, code] of [[{ endedAt: new Date() }, "COURSE_ENDED"], [{ droppedAt: new Date() }, "COURSE_DROPPED"]] as const) {
      const w = world(tenSessions(), course);
      arm(w);
      await expect(sched.changeCourseTeacherAndTime(COURSE, input(), "admin")).rejects.toMatchObject({ status: 409, code });
      expect(w.committed).toEqual([]);
      spies.splice(0).forEach((s) => s.mockRestore());
    }
  });
  test("the expiry GROWS to cover the new last date and NEVER shrinks (recorded through the one writer, with the admin as actor)", async () => {
    const dates = courseSessionDates(NEW_START, 4);
    const grow = world(tenSessions(), { expiryDate: "2099-03-30" });
    arm(grow);
    const g: any = await sched.changeCourseTeacherAndTime(COURSE, input(), "admin");
    expect(g.expiryExtended).toBe(true);
    expect(g.previousExpiryDate).toBe("2099-03-30");
    expect(g.expiryDate >= dates[3]!).toBe(true); // it now covers the last new session
    expect(g.expiryDate > "2099-03-30").toBe(true); // …and it MOVED (grew)
    expect(grow.expiryRecords).toEqual([{ courseId: COURSE, from: "2099-03-30", to: g.expiryDate, actor: "admin" }]);
    spies.splice(0).forEach((s) => s.mockRestore());
    const keep = world(tenSessions(), { expiryDate: "2099-12-31" });
    arm(keep);
    const k: any = await sched.changeCourseTeacherAndTime(COURSE, input(), "admin");
    expect(k.expiryDate).toBe("2099-12-31"); // a re-plan that finishes early takes nothing back
    expect(k.expiryExtended).toBe(false);
  });
});

describe("🔴 the preview IS the act — run in a rolled-back transaction", () => {
  test("it writes nothing (0 committed rows, 0 notices) and answers the act's own { n, firstDate, lastDate }", async () => {
    const w = world(tenSessions());
    arm(w);
    const p: any = await sched.previewCourseTeacherAndTime(COURSE, input());
    const dates = courseSessionDates(NEW_START, 4);
    expect(p).toEqual({ n: 4, firstDate: dates[0], lastDate: dates[3] });
    expect(w.committed).toEqual([]);
    expect(w.journal).toEqual([]);
    expect(w.outbox).toEqual([]);
    const a: any = await sched.changeCourseTeacherAndTime(COURSE, input(), "admin");
    expect({ n: a.n, firstDate: a.firstDate, lastDate: a.lastDate }).toEqual(p); // the preview EQUALS the act
  });
  test("a clash ⇒ the preview answers `clashes: [date]` (and still writes nothing) where the act would refuse", async () => {
    const w = world(tenSessions(), {}, 2);
    arm(w);
    const p: any = await sched.previewCourseTeacherAndTime(COURSE, input());
    expect(p.n).toBe(4);
    expect(p.clashes).toHaveLength(1);
    expect(courseSessionDates(NEW_START, 4)).toContain(p.clashes[0]);
    expect(w.committed).toEqual([]);
  });
  test("an ended course is refused by the preview too (same words as the act)", async () => {
    const w = world(tenSessions(), { endedAt: new Date() });
    arm(w);
    await expect(sched.previewCourseTeacherAndTime(COURSE, input())).rejects.toMatchObject({ code: "COURSE_ENDED" });
  });
});

describe("the plan (pure) — which rows, the write order, the refusals", () => {
  test("only live rows dated today or later move; delivered / cancelled / past rows are not in the plan", () => {
    const rows = [...tenSessions(), live("x", "2099-03-30", "CANCELLED"), live("past", "2020-06-01", "CONFIRMED")];
    const p = planCourseTeacherTimeChange(rows, input(), "2026-01-01");
    expect(isTeacherTimeRefusal(p)).toBe(false);
    expect((p as any).moves.map((m: any) => m.id)).toEqual(["c1", "p1", "p2", "p3"]);
  });
  test("🔑 a shift of one week with the SAME teacher and hour never lands on a sibling that has not left: the order is safe", () => {
    const rows = [live("a", "2099-05-04", "PENDING"), live("b", "2099-05-11", "PENDING"), live("c", "2099-05-18", "PENDING")].map((r) => ({ ...r, startTime: "15:00:00" }));
    const p = planCourseTeacherTimeChange(rows, { teacherId: T1, startDate: "2099-05-11", startTime: "15:00" }, "2026-01-01") as any;
    expect(p.order).toEqual(["c", "b", "a"]); // a forward shift moves the LAST row first
    const q = planCourseTeacherTimeChange(rows, { teacherId: T1, startDate: "2099-04-27", startTime: "15:00" }, "2026-01-01") as any;
    expect(q.order).toEqual(["a", "b", "c"]); // a backward shift moves the FIRST row first
  });
  test("START_IN_PAST and NOTHING_TO_MOVE refuse with the existing words", () => {
    expect(planCourseTeacherTimeChange(tenSessions(), { teacherId: T2, startDate: "2020-01-01", startTime: "15:00" }, "2026-01-01")).toMatchObject({ code: "START_IN_PAST" });
    expect(planCourseTeacherTimeChange([...[0, 1, 2].map(delivered)], input(), "2026-01-01")).toEqual({ code: "NOTHING_TO_MOVE", message: "คอร์สนี้ไม่มีคาบให้ย้าย" });
  });
});

describe("the coach notice's renderer — `sessions` absent ⇒ the OLD bytes; present ⇒ the existing Time line once per session", () => {
  const ctx: any = { studentName: "น้องเอ", subject: "Inline", date: "2099-03-02", startTime: "10:00", endTime: "11:00" };
  test("absent ⇒ byte-identical to today (ONE Time line)", () => {
    const out = formatOutboxMessage({ kind: "teacher_assigned", bookingId: "r1" } as any, ctx, "EN", "teacher");
    expect(out.split("\n")[0]).toBe("👩‍🏫 A class has been assigned to you");
    expect(out).toContain("02-03-2099 10:00-11:00"); // the booking's OWN slot, the one Time line
    expect(out.split("\n").filter((l) => /^Time/i.test(l))).toHaveLength(1);
    expect(formatOutboxMessage({ kind: "teacher_assigned", bookingId: "r1", sessions: [] } as any, ctx, "EN", "teacher")).toBe(out); // an EMPTY list is the same as no list
  });
  test("3 sessions ⇒ 3 Time lines, in DATE order whatever order they came in; the title / Student / Subject unchanged; the old message's own Time line is NOT printed", () => {
    const sessions = [{ date: "2099-03-16", startTime: "15:00", endTime: "16:00" }, { date: "2099-03-02", startTime: "15:00", endTime: "16:00" }, { date: "2099-03-09", startTime: "15:00", endTime: "16:00" }];
    for (const kind of ["teacher_assigned", "teacher_unassigned"] as const) {
      const out = formatOutboxMessage({ kind, bookingId: "r1", sessions } as any, ctx, "EN", "teacher");
      const times = out.split("\n").filter((l) => /^Time/i.test(l));
      expect(times).toHaveLength(3);
      expect(times.map((l) => l.replace(/^Time:?\s*/i, ""))).toEqual(["02-03-2099 15:00-16:00", "09-03-2099 15:00-16:00", "16-03-2099 15:00-16:00"]);
      expect(out).not.toContain("10:00-11:00"); // the booking's own slot is not printed when the list is
      expect(out).toContain("น้องเอ");
      expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no raw ISO date leaks
    }
    const th = formatOutboxMessage({ kind: "teacher_assigned", bookingId: "r1", sessions } as any, ctx, "TH", "teacher");
    expect(th.split("\n").filter((l) => /^เวลา|^Time/i.test(l)).length).toBeGreaterThanOrEqual(3);
  });
});

describe("🔑 by source — the doors", () => {
  const SVC = code(read("src/services/scheduler.service.ts"));
  test("the routes: a pair, validated by the same schema, the act passes the actor, the preview does not; both gated by `action:bookings.course-plan` (a RE-PLAN, like the start-date change) and EQUAL to each other", () => {
    const API = code(read("src/routes/api.ts"));
    expect(API).toContain('.post("/courses/:id/change-teacher-time/preview", zValidator("json", v.changeCourseTeacherTime)');
    expect(API).toContain('.post("/courses/:id/change-teacher-time", zValidator("json", v.changeCourseTeacherTime)');
    expect(API).toContain("svc.changeCourseTeacherAndTime(c.req.param(\"id\"), c.req.valid(\"json\"), actorOf(c))");
    expect(API).toContain("svc.previewCourseTeacherAndTime(c.req.param(\"id\"), c.req.valid(\"json\"))");
    expect(ROUTE_ACCESS["POST /courses/:id/change-teacher-time"]).toEqual(ROUTE_ACCESS["POST /courses/:id/change-teacher-time/preview"]);
    expect(JSON.stringify(ROUTE_ACCESS["POST /courses/:id/change-teacher-time"])).toContain("action:bookings.course-plan");
    expect(JSON.stringify(ROUTE_ACCESS["POST /courses/:id/change-teacher-time"])).not.toContain("course-edit");
    expect(ROUTE_ACCESS["POST /courses/:id/change-teacher-time"]).toEqual(ROUTE_ACCESS["POST /courses/:id/start-date"]); // the same key as the other re-plan door (TASK-570)
  });
  test("the act: ONE transaction, the course-writable gate first, the planner, no insert and no cancel, the preview = the act inside a rollback", () => {
    const run = SVC.slice(SVC.indexOf("async function runCourseTeacherTimeChange("), SVC.indexOf("export async function changeCourseTeacherAndTime("));
    expect(run.indexOf("await assertCourseWritable(tx, id)")).toBeGreaterThan(-1);
    expect(run.indexOf("await assertCourseWritable(tx, id)")).toBeLessThan(run.indexOf("planCourseTeacherTimeChange("));
    expect(run).toContain("await assertTeacherBookable(tx, m.to.teacherId, m.to.date);");
    expect(run).not.toMatch(/\.insert\(|insertBooking\(|"CANCELLED"|droppedAt|usedSessions|leaveUsed/);
    expect(run).toContain("const expiryDate = replanExpiry(course.expiryDate, plan.lastDate);");
    expect(run).toContain("await sendCourseTeacherChange(tx, plan.moves);");
    expect(run).not.toContain("db.transaction("); // the act's body runs INSIDE the caller's transaction
    const prev = SVC.slice(SVC.indexOf("export async function previewCourseTeacherAndTime("), SVC.indexOf("// ─────────── TASK-439"));
    expect(prev).toContain("await runCourseTeacherTimeChange(tx, id, input, null);");
    expect(prev).toContain("throw new CourseChangeRollback(");
    expect(prev).not.toContain("changeCourseTeacherAndTime(");
  });
  test("the notice: ONE helper, called once per act, only rows whose teacher changes; no per-row send and no family sender", () => {
    const h = SVC.slice(SVC.indexOf("async function sendCourseTeacherChange("), SVC.indexOf("async function sendClassCancelledToOtherTeachers("));
    expect(h).toContain('const changed = moves.filter((m) => m.from.teacherId !== m.to.teacherId);');
    expect(h).not.toMatch(/for \(const m of moves\)[^]*enqueueLine/);
    expect(h).not.toMatch(/enqueueParentCopies|recipientType: "parent"|sendClassCancelledToFamilies/);
    expect([...SVC.matchAll(/sendCourseTeacherChange\(/g)]).toHaveLength(2); // the definition + the one call
  });
});
