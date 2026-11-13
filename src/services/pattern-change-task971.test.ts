// 🔻 TASK-971 (REQ-5016 AC5 + AC6, SPEC-109 §3.4) — the change-pattern ACT and the RESUME of a pattern course, through the real service functions over a fake transaction (no database): the rows moved, `course_slots` rewritten (2+) or deleted (1),
// the coach pair, the refusals that write nothing, the preview = the act in a rollback; and a resume that re-plans a pattern course onto its slots while a one-slot course runs the old path byte for byte.
// 🚫 It models the database; the real rows, FKs and the rollback are the rolled-back sid proof (TASK-971 Notes).
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { db } from "../db";
import * as sched from "./scheduler.service";
import * as lineLib from "../lib/line";
import * as patternSvc from "./course-pattern-change.service";
import * as v from "../validation";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const read = (p: string) => readFileSync(resolve(import.meta.dir, "..", "..", p), "utf8");
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const START = "2026-11-02"; // a Monday
const TUE_B = { weekday: 2, startTime: "10:00", teacherId: B }, THU_A = { weekday: 4, startTime: "11:00", teacherId: A };
const row = (id: string, date: string, status: string, o: Record<string, unknown> = {}) => ({ id, courseId: "c1", date, startTime: "10:00:00", endTime: "11:00:00", status, teacherId: A, bookingType: "COURSE_PACKAGE", groupId: null, ...o });
const ROWS = () => [row("a1", "2026-11-02", "ATTENDED"), row("a2", "2026-11-09", "ATTENDED"), row("p1", "2026-11-16", "CONFIRMED"), row("p2", "2026-11-23", "PENDING"), row("p3", "2026-11-30", "PENDING"), row("p4", "2026-12-07", "PENDING")];
const COURSE = (o: Record<string, unknown> = {}) => ({ id: "c1", startDate: START, expiryDate: "2027-02-01", size: 6, usedSessions: 2, leaveUsed: 0, weekday: 1, startTime: "10:00:00", endedAt: null, droppedAt: null, studentId: "s1", coStudentId: null, subjectId: "sub1", priorSessions: 0, ...o });

type World = { course?: any; rows?: any[]; slots?: any[]; clashOn?: string };
function fakeTx(w: World) {
  const writes: Array<{ op: string; table: string; v?: any }> = [];
  const tx: any = {
    query: {
      coursePackages: { findFirst: async () => w.course },
      bookings: { findMany: async () => w.rows ?? [], findFirst: async () => undefined },
      courseSlots: { findMany: async () => w.slots ?? [] },
      teachers: { findFirst: async (q: any) => ({ id: q.where({}, { eq: (_c: unknown, v: string) => v }), nickname: "Coach", lineUserId: null, isSystem: false, archived: false }) },
    },
    update: (t: any) => ({ set: (v: any) => ({ where: () => {
      const name = getTableName(t);
      if (name === "bookings" && w.clashOn && v.date === w.clashOn) throw Object.assign(new Error("duplicate key bookings_teacher_slot_uq"), { code: "23505" });
      writes.push({ op: "update", table: name, v });
      return Object.assign(Promise.resolve(), { returning: async () => [] });
    } }) }),
    delete: (t: any) => ({ where: async () => { writes.push({ op: "delete", table: getTableName(t) }); } }),
    insert: (t: any) => ({ values: (v: any) => { writes.push({ op: "insert", table: getTableName(t), v }); return Object.assign(Promise.resolve(), { returning: async () => [{ id: "x" }] }); } }),
    transaction: async (fn: any) => fn(tx),
  };
  return { tx, writes };
}
async function run<T>(w: World, fn: () => Promise<T>) {
  setSystemTime(new Date("2026-11-13T03:00:00Z"));
  const { tx, writes } = fakeTx(w);
  const outbox: any[] = [];
  const prev = (db as any).transaction;
  (db as any).transaction = async (f: any) => f(tx);
  spies.push(spyOn(sched, "assertTeacherBookable").mockImplementation((async () => ({})) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
  spies.push(spyOn(sched, "loadBookingDTO").mockImplementation((async (_e: any, id: string) => ({ id })) as any));
  spies.push(spyOn(sched, "recordExpiryChange").mockImplementation((async (_e: any, r: any) => { writes.push({ op: "expiry", table: "course_expiry_changes", v: r }); }) as any));
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (r: any) => { outbox.push(r); return { status: "queued" } as any; }) as any));
  try { return { out: await fn(), writes, outbox, err: null as any }; } catch (e) { return { out: null as T | null, writes, outbox, err: e }; } finally { (db as any).transaction = prev; }
}
const code = (e: any) => e?.code;

describe("🔴 TASK-971 — change-pattern: the rows, `course_slots`, the course, the coach pair", () => {
  test("4 untaught rows → the new 2-slot pattern: ONLY those rows are written (each its slot's coach / date / time), taught rows are not; `course_slots` replaced; the course keeps size / used / leave", async () => {
    const r = await run({ course: COURSE(), rows: ROWS(), slots: [] }, () => patternSvc.changeCoursePattern("c1", { fromDate: "2026-11-16", pattern: [TUE_B, THU_A] }, "admin"));
    expect(r.err).toBeNull();
    const b = r.writes.filter((x) => x.table === "bookings" && x.op === "update");
    expect(b).toHaveLength(4);
    expect(b.map((x) => [x.v.date, x.v.startTime, x.v.teacherId]).sort()).toEqual([["2026-11-17", "10:00", B], ["2026-11-19", "11:00", A], ["2026-11-24", "10:00", B], ["2026-11-26", "11:00", A]]);
    expect(r.writes.filter((x) => x.table === "course_slots").map((x) => x.op)).toEqual(["delete", "insert"]);
    expect(r.writes.find((x) => x.op === "insert" && x.table === "course_slots")!.v).toEqual([
      { courseId: "c1", ord: 0, weekday: 2, startTime: "10:00", teacherId: B }, { courseId: "c1", ord: 1, weekday: 4, startTime: "11:00", teacherId: A },
    ]);
    const c = r.writes.find((x) => x.table === "course_packages")!.v;
    for (const k of ["size", "usedSessions", "leaveUsed", "firstTeacherId", "studentId"]) expect(c).not.toHaveProperty(k);
    expect(r.out).toMatchObject({ moved: 4, firstDate: "2026-11-17", lastDate: "2026-11-26", patternSlots: 2 });
  });
  test("a CONFIRMED row is reset (confirmedAt / token cleared) and PENDING; the course is flagged `reconfirmNeededSince`", async () => {
    const r = await run({ course: COURSE(), rows: ROWS(), slots: [] }, () => patternSvc.changeCoursePattern("c1", { fromDate: "2026-11-16", pattern: [TUE_B, THU_A] }));
    const reset = r.writes.filter((x) => x.table === "bookings" && x.v.status === "PENDING" && "confirmedAt" in x.v);
    expect(reset).toHaveLength(1);
    expect(reset[0]!.v).toMatchObject({ status: "PENDING", confirmedAt: null, checkinToken: null, checkinTokenExpiresAt: null });
    expect(r.writes.find((x) => x.table === "course_packages")!.v).toHaveProperty("reconfirmNeededSince");
    expect((r.out as any).notices.needsReconfirm).toBe(1);
  });
  test("a ONE-slot result ⇒ `course_slots` is DELETED (no insert) and the course's own weekday / start_time carry the slot; a coach change is recorded", async () => {
    const r = await run({ course: COURSE(), rows: ROWS(), slots: [{ id: "s0" }, { id: "s1" }] }, () => patternSvc.changeCoursePattern("c1", { fromDate: "2026-11-16", pattern: [TUE_B] }));
    expect(r.err).toBeNull();
    expect(r.writes.filter((x) => x.table === "course_slots").map((x) => x.op)).toEqual(["delete"]);
    expect(r.writes.find((x) => x.table === "course_packages")!.v).toMatchObject({ weekday: 2, startTime: "10:00", latestTeacherId: B });
    expect((r.out as any).patternSlots).toBe(1);
  });
  test("the coach pair (TASK-838's): ONE `teacher_unassigned` to the old coach, ONE `teacher_assigned` to the new — and nobody else (the family hears at the re-confirm)", async () => {
    const r = await run({ course: COURSE(), rows: ROWS(), slots: [] }, () => patternSvc.changeCoursePattern("c1", { fromDate: "2026-11-16", pattern: [TUE_B] }));
    expect(r.outbox.map((o) => [o.recipientType, o.payload.kind])).toEqual([["teacher", "teacher_unassigned"], ["teacher", "teacher_assigned"]]);
    expect(r.outbox.some((o) => o.recipientType === "parent")).toBe(false);
  });
  test("the expiry grows to cover the new last row (never shrinks) and is recorded", async () => {
    const r = await run({ course: COURSE({ expiryDate: "2026-12-01" }), rows: ROWS(), slots: [] }, () => patternSvc.changeCoursePattern("c1", { fromDate: "2026-11-16", pattern: [TUE_B] }, "admin"));
    expect(r.out).toMatchObject({ expiryExtended: true, previousExpiryDate: "2026-12-01" });
    expect(r.writes.find((x) => x.op === "expiry")!.v).toMatchObject({ courseId: "c1", from: "2026-12-01", actor: "admin" });
    const keep = await run({ course: COURSE({ expiryDate: "2030-01-01" }), rows: ROWS(), slots: [] }, () => patternSvc.changeCoursePattern("c1", { fromDate: "2026-11-16", pattern: [TUE_B] }));
    expect((keep.out as any).expiryExtended).toBe(false);
  });
});

describe("🔴 TASK-971 — change-pattern: refusals write NOTHING", () => {
  test("a clash on a moved row ⇒ 409 SLOT_TAKEN naming the date; `course_slots` and the course are never touched", async () => {
    const r = await run({ course: COURSE(), rows: ROWS(), slots: [], clashOn: "2026-11-24" }, () => patternSvc.changeCoursePattern("c1", { fromDate: "2026-11-16", pattern: [TUE_B, THU_A] }));
    expect([r.err?.status, code(r.err), r.err?.details]).toEqual([409, "SLOT_TAKEN", { date: "2026-11-24", time: "10:00" }]);
    expect(r.writes.some((x) => x.table === "course_slots" || x.table === "course_packages")).toBe(false);
    expect(r.outbox).toHaveLength(0);
  });
  test("PATTERN_INVALID → 400 VALIDATION · START_IN_PAST → 400 · NOTHING_TO_MOVE → 409 · an ended / paused course → its own code — each with zero writes", async () => {
    const cases: Array<[string, World, { fromDate: string; pattern: any[] }, [number, string]]> = [
      ["invalid", { course: COURSE(), rows: ROWS() }, { fromDate: "2026-11-16", pattern: [TUE_B, TUE_B] }, [400, "VALIDATION"]],
      ["past", { course: COURSE(), rows: ROWS() }, { fromDate: "2026-11-12", pattern: [TUE_B] }, [400, "START_IN_PAST"]],
      ["none", { course: COURSE(), rows: ROWS().filter((x) => x.status === "ATTENDED") }, { fromDate: "2026-11-16", pattern: [TUE_B] }, [409, "NOTHING_TO_MOVE"]],
      ["ended", { course: COURSE({ endedAt: new Date("2026-11-01T03:00:00Z") }), rows: ROWS() }, { fromDate: "2026-11-16", pattern: [TUE_B] }, [409, "COURSE_ENDED"]],
      ["paused", { course: COURSE({ droppedAt: new Date("2026-11-01T03:00:00Z") }), rows: ROWS() }, { fromDate: "2026-11-16", pattern: [TUE_B] }, [409, "COURSE_DROPPED"]],
    ];
    for (const [name, w, input, [status, c]] of cases) {
      const r = await run({ ...w, slots: [] }, () => patternSvc.changeCoursePattern("c1", input));
      expect({ name, status: r.err?.status, code: code(r.err), writes: r.writes.length }).toEqual({ name, status, code: c, writes: 0 });
    }
  });
  test("the PREVIEW answers the act's own numbers (it is the act inside a rollback) and shares every refusal", async () => {
    const act = await run({ course: COURSE(), rows: ROWS(), slots: [] }, () => patternSvc.changeCoursePattern("c1", { fromDate: "2026-11-16", pattern: [TUE_B, THU_A] }));
    const prev = await run({ course: COURSE(), rows: ROWS(), slots: [] }, () => patternSvc.previewCoursePattern("c1", { fromDate: "2026-11-16", pattern: [TUE_B, THU_A] }));
    expect(prev.err).toBeNull();
    expect(prev.out).toEqual(act.out);
    const clash = await run({ course: COURSE(), rows: ROWS(), slots: [], clashOn: "2026-11-24" }, () => patternSvc.previewCoursePattern("c1", { fromDate: "2026-11-16", pattern: [TUE_B, THU_A] }));
    expect(code(clash.err)).toBe("SLOT_TAKEN");
    expect(read("src/services/course-pattern-change.service.ts")).toContain("throw new PatternPreviewRollback(await runCoursePatternChange(tx, id, input, null));");
  });
});

describe("🔒 TASK-971 — the body, the routes and their gates (by value / by source)", () => {
  const ok = (b: unknown) => v.changeCoursePattern.safeParse(b).success;
  test("body: `fromDate` + 1…21 slots; a ONE-slot pattern is legal HERE; 0 / 22 slots, a duplicate (weekday, time), a quarter hour and a bad date are refused", () => {
    expect(ok({ fromDate: "2026-11-16", pattern: [TUE_B] })).toBe(true);
    expect(ok({ fromDate: "2026-11-16", pattern: [TUE_B, THU_A] })).toBe(true);
    expect(ok({ fromDate: "2026-11-16", pattern: [] })).toBe(false);
    expect(ok({ fromDate: "2026-11-16", pattern: Array.from({ length: 22 }, (_, i) => ({ weekday: i % 7, startTime: "10:00", teacherId: A })) })).toBe(false);
    expect(ok({ fromDate: "2026-11-16", pattern: [TUE_B, TUE_B] })).toBe(false);
    expect(ok({ fromDate: "2026-11-16", pattern: [{ ...TUE_B, startTime: "10:15" }] })).toBe(false);
    expect(ok({ fromDate: "16/11/2026", pattern: [TUE_B] })).toBe(false);
  });
  test("the two routes call the act / the preview and sit behind the SAME gate as change-teacher-time; the whole-day flag reaches its own function", () => {
    const API = read("src/routes/api.ts"), RA = read("src/lib/route-access.ts");
    expect(API).toContain('.post("/courses/:id/change-pattern/preview", zValidator("json", v.changeCoursePattern), async (c) =>');
    expect(API).toContain("c.json(await patternChange.previewCoursePattern(c.req.param(\"id\"), c.req.valid(\"json\"))),");
    expect(API).toContain("c.json(await patternChange.changeCoursePattern(c.req.param(\"id\"), c.req.valid(\"json\"), actorOf(c))),");
    expect(RA).toContain('"POST /courses/:id/change-pattern": act(BOOKINGS, "action:bookings.course-plan")');
    expect(RA).toContain('"POST /courses/:id/change-pattern/preview": act(BOOKINGS, "action:bookings.course-plan")');
    expect(API).toContain("if (wholeDay) return c.json(await svc.recordWholeDayLeave(");
  });
});

describe("🔴 TASK-971 — resume: a pattern course re-plans onto its pattern; a one-slot course keeps today's path", () => {
  const dropped = (o: Record<string, unknown> = {}) => COURSE({ droppedAt: new Date("2026-11-10T03:00:00Z"), size: 4, usedSessions: 2, ...o });
  const pausedRows = () => [row("a1", "2026-11-02", "ATTENDED"), row("a2", "2026-11-09", "ATTENDED"), row("c1", "2026-11-16", "CANCELLED"), row("c2", "2026-11-23", "CANCELLED")];
  async function resume(slots: any[]) {
    const inserted: any[] = [];
    const w: World = { course: dropped(), rows: pausedRows(), slots };
    setSystemTime(new Date("2026-11-13T03:00:00Z"));
    spies.push(spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, _s: any, input: any) => { inserted.push(input); return `n${inserted.length}`; }) as any));
    const r = await run(w, () => sched.resumeCourse("c1", { startDate: "2026-11-16", startTime: "09:00", teacherId: A }));
    return { r, inserted };
  }
  test("a PATTERN course (2 slots): the 2 owed rows land on the PATTERN from the resume date — each its slot's coach and time, NOT the admin's single time / coach; the course's weekday / start_time are left alone", async () => {
    const { r, inserted } = await resume([{ weekday: 2, startTime: "10:00:00", teacherId: B, ord: 0 }, { weekday: 4, startTime: "11:00:00", teacherId: A, ord: 1 }]);
    expect(r.err).toBeNull();
    expect(inserted.map((i) => [i.date, i.startTime, i.teacherId])).toEqual([["2026-11-17", "10:00", B], ["2026-11-19", "11:00", A]]);
    const upd = r.writes.find((x) => x.table === "course_packages")!.v;
    expect(upd).toMatchObject({ droppedAt: null });
    expect(upd).not.toHaveProperty("weekday");
    expect(upd).not.toHaveProperty("startTime");
  });
  test("a ONE-slot course (no slots): today's path byte for byte — the admin's start date + time, ONE weekly slot; the course's weekday / start_time follow the answer", async () => {
    const { r, inserted } = await resume([]);
    expect(r.err).toBeNull();
    expect(inserted.map((i) => [i.date, i.startTime, i.teacherId])).toEqual([["2026-11-16", "09:00", A], ["2026-11-23", "09:00", A]]);
    expect(r.writes.find((x) => x.table === "course_packages")!.v).toMatchObject({ weekday: 1, startTime: "09:00" });
  });
  test("a course with ONE `course_slots` row is a one-slot course (the pattern branch needs 2+)", async () => {
    const { inserted } = await resume([{ weekday: 2, startTime: "10:00:00", teacherId: B, ord: 0 }]);
    expect(inserted.map((i) => i.startTime)).toEqual(["09:00", "09:00"]);
  });
});
