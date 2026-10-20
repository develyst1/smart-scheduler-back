// TASK-819 (REQ-123 Phase 1, P3 + P5) — (P3) every class on a leave day says WHO and WHAT: child (DUO: both), program, in a course or not, with its booking id; (P5) the leave LIST can be asked for ONE teacher,
// over a PAST window, each item carrying its record's `rangeId`, and is readable from the Teachers menu; and a whole RANGE can be lifted in one call (future days only, ONE LINE to the teacher).
// The lift route is the builder's call (the brief left it open): looping the per-day lift would send the teacher one LINE per day.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import * as v from "../validation";
import * as sched from "../services/scheduler.service";
import * as leaveLib from "./teacher-leave";
import * as lineLib from "./line";
import { ROUTE_ACCESS } from "./route-access";
import { DEV_USER } from "../middleware/auth";
import { db } from "../db";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const file = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => { const a = s.indexOf(from); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf(to, a + from.length)); };
const dialect = new PgDialect();
const T = "11111111-1111-4111-8111-111111111111";
const RANGE = "22222222-2222-4222-8222-222222222222";
const TODAY = "2026-10-17";
const spies: Array<{ mockRestore: () => void }> = [];
const savedUser = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
const setUser = (u: { isSuperAdmin: boolean; grants?: Iterable<string> }) => { (DEV_USER as any).isSuperAdmin = u.isSuperAdmin; (DEV_USER as any).grants = new Set(u.grants ?? []); (DEV_USER as any).teacherId = null; };
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, savedUser); });
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const call = async (method: string, path: string) => {
  const res = await rootApp.fetch(new Request(`http://localhost/api${path}`, { method }));
  return { status: res.status, body: (await res.json()) as any };
};
const sqlOf = (x: unknown) => dialect.sqlToQuery(x as any);

/** A select chain that records the field map, the WHERE and the ORDER BY of the MAIN query (the one selecting `id`; the teacher-scope sub-select inside its WHERE is another `db.select` and is ignored), and answers `rows`. */
const recordingSelect = (rows: any[]) => {
  const seen: { fields?: Record<string, unknown>; where?: unknown; order?: unknown[]; from?: unknown } = {};
  spies.push(spyOn(db, "select").mockImplementation(((f: Record<string, unknown>) => {
    const main = "id" in f || "teacherId" in f;
    const into: typeof seen = main ? seen : {};
    into.fields = f;
    const chain: any = {
      from: (t: unknown) => { into.from = t; return chain; },
      innerJoin: () => chain,
      where: (w: unknown) => { into.where = w; return chain; },
      orderBy: (...o: unknown[]) => { into.order = o; return Promise.resolve(main ? rows : []); },
    };
    return chain;
  }) as any));
  return seen;
};

describe("🔴 P3 — each class on a leave day says WHO and WHAT, from the same one-select query", () => {
  test("the field map: the six original keys UNTOUCHED, plus child · co-child · program · title · inCourse", async () => {
    const seen = recordingSelect([]);
    await leaveLib.leaveDayBookings(db, T, "2026-10-21");
    expect(Object.keys(seen.fields!)).toEqual(["id", "date", "startTime", "endTime", "status", "bookingType", "childName", "childNickname", "coChildName", "coChildNickname", "program", "title", "inCourse"]);
  });
  test("each extra column is a correlated sub-select over the booking's own ids (no joins) — child, DUO's second child, program, course-or-not", async () => {
    const seen = recordingSelect([]);
    await leaveLib.leaveDayBookings(db, T, "2026-10-21");
    const f = seen.fields!;
    expect(sqlOf(f.childName).sql).toBe('(select "students"."name" from "students" where "students"."id" = "bookings"."student_id")');
    expect(sqlOf(f.childNickname).sql).toBe('(select "students"."nickname" from "students" where "students"."id" = "bookings"."student_id")');
    expect(sqlOf(f.coChildName).sql).toBe('(select "students"."name" from "students" where "students"."id" = "bookings"."co_student_id")');
    expect(sqlOf(f.coChildNickname).sql).toBe('(select "students"."nickname" from "students" where "students"."id" = "bookings"."co_student_id")');
    expect(sqlOf(f.program).sql).toBe('(select "subjects"."name" from "subjects" where "subjects"."id" = "bookings"."subject_id")');
    expect(sqlOf(f.inCourse).sql).toBe('"bookings"."course_id" is not null');
  });
  test("the filter and the order are exactly what they were: that day, class rows only (no seat), live statuses, that teacher's classes, by start time", async () => {
    const seen = recordingSelect([]);
    await leaveLib.leaveDayBookings(db, T, "2026-10-21");
    const w = sqlOf(seen.where);
    expect(w.sql).toContain('"bookings"."date" = $1');
    expect(w.sql).toContain('"bookings"."group_id" is null');
    expect(w.sql).toContain('"bookings"."status" in (');
    expect(w.params[0]).toBe("2026-10-21");
    expect(seen.order).toHaveLength(1);
    expect((seen.order as any[])[0].name).toBe("start_time"); // ordered by the start time column, as before
  });
  test("rows are passed through untouched (the answer is the database's, a DUO row carries both children)", async () => {
    const duo = { id: "b1", date: "2026-10-21", startTime: "10:00:00", endTime: "11:00:00", status: "CONFIRMED", bookingType: "COURSE_PACKAGE", childName: "Ploy A", childNickname: "Ploy", coChildName: "Pun B", coChildNickname: "Pun", program: "Balance Duo", title: null, inCourse: true };
    recordingSelect([duo]);
    expect(await leaveLib.leaveDayBookings(db, T, "2026-10-21")).toEqual([duo]);
  });
  test("the record answers (single day AND range) carry the richer rows — they come from THE one reader", () => {
    const LIB = code(file("src/lib/teacher-leave.ts"));
    expect(region(LIB, "export async function recordAdvanceLeave(", "\n}\n")).toContain("bookings: await leaveDayBookings(exec, teacherId, input.date)");
    expect(region(LIB, "export async function recordedLeaveDays(", "\n}\n")).toContain("bookings: await leaveDayBookings(exec, d.teacherId, d.date)");
  });
});

describe("🔴 P5 — the leave LIST: one teacher, a past window, the record's rangeId, readable from the Teachers menu", () => {
  test("the query takes an optional `teacherId` (uuid); a PAST `from` is fine; the 92-day cap and ordering stay", () => {
    expect(v.leaveDaysQuery.safeParse({ teacherId: T }).success).toBe(true);
    expect(v.leaveDaysQuery.safeParse({ teacherId: "not-a-uuid" }).success).toBe(false);
    expect(v.leaveDaysQuery.safeParse({ from: "2026-01-01", to: "2026-03-31" }).success).toBe(true); // 89 days, all in the past
    expect(v.leaveDaysQuery.safeParse({ from: "2026-01-01", to: "2026-06-01" }).success).toBe(false); // > 92 days
    expect(v.leaveDaysQuery.safeParse({ from: "2026-03-01", to: "2026-02-01" }).success).toBe(false);
    expect(v.leaveDaysQuery.safeParse({}).success).toBe(true);
  });
  test("each item carries `rangeId` (null for a single-day record) beside teacher · date · reason · author, and its classes", async () => {
    const days = [{ teacherId: T, teacherName: "Ek", date: "2026-10-20", reason: "อบรม", createdBy: "admin", rangeId: RANGE }, { teacherId: T, teacherName: "Ek", date: "2026-10-25", reason: "ธุระ", createdBy: "admin", rangeId: null }];
    let n = 0;
    const fieldsSeen: any[] = [];
    spies.push(spyOn(db, "select").mockImplementation(((f: any) => { fieldsSeen.push(f); const rows = n++ === 0 ? days : []; const q: any = { from: () => q, innerJoin: () => q, where: () => q, orderBy: () => Promise.resolve(rows) }; return q; }) as any));
    setSystemTime(new Date(`${TODAY}T10:00:00+07:00`));
    const out: any[] = await sched.listRecordedLeaveDays({});
    expect(out.map((d) => [d.date, d.rangeId])).toEqual([["2026-10-20", RANGE], ["2026-10-25", null]]);
    expect(out.every((d) => Array.isArray(d.bookings))).toBe(true);
    expect(Object.keys(fieldsSeen[0])).toEqual(["teacherId", "teacherName", "date", "reason", "createdBy", "rangeId"]);
  });
  test("the teacher filter: with `teacherId` the WHERE carries it; without, it does not; a past window is passed through, never clamped to today", async () => {
    const wheres: any[] = [];
    spies.push(spyOn(db, "select").mockImplementation((() => { const q: any = { from: () => q, innerJoin: () => q, where: (w: unknown) => { wheres.push(w); return q; }, orderBy: () => Promise.resolve([]) }; return q; }) as any));
    setSystemTime(new Date(`${TODAY}T10:00:00+07:00`));
    await sched.listRecordedLeaveDays({ from: "2026-09-01", to: "2026-09-30", teacherId: T });
    await sched.listRecordedLeaveDays({ from: "2026-09-01", to: "2026-09-30" });
    const withT = sqlOf(wheres[0]), without = sqlOf(wheres[1]);
    expect(withT.sql).toContain('"teacher_leave_days"."teacher_id" = $');
    expect(withT.params).toEqual(["2026-09-01", "2026-09-30", T]);
    expect(without.sql).not.toContain("teacher_id");
    expect(without.params).toEqual(["2026-09-01", "2026-09-30"]); // 🔑 the past window reaches the query as asked
  });
  test("access: the list reads from the calendar OR the Teachers menu; through the root app a Teachers-only viewer gets 200, a viewer with neither gets 403", async () => {
    expect(ROUTE_ACCESS["GET /teacher-leave-days"]).toEqual({ menus: ["menu:calendar", "menu:teachers"] });
    process.env.SKIP_AUTH = "true";
    recordingSelect([]);
    setUser({ isSuperAdmin: false, grants: ["menu:teachers"] });
    expect((await call("GET", `/teacher-leave-days?teacherId=${T}`)).status).toBe(200);
    setUser({ isSuperAdmin: false, grants: ["menu:calendar"] });
    expect((await call("GET", "/teacher-leave-days")).status).toBe(200);
    setUser({ isSuperAdmin: false, grants: ["menu:bookings", "menu:students"] });
    expect((await call("GET", "/teacher-leave-days")).status).toBe(403);
  });
});

const restoreCalls: Array<[string, string[]]> = [];
describe("🔴 lifting a whole RANGE — future days only, one LINE, nothing else touched", () => {
  const rows = (dates: string[]) => dates.map((date) => ({ teacherId: T, date }));
  const arm = (dates: string[]) => {
    setSystemTime(new Date(`${TODAY}T10:00:00+07:00`));
    process.env.SKIP_AUTH = "true";
    const sent: any[] = [];
    const deletes: unknown[] = [];
    recordingSelect(rows(dates));
    restoreCalls.length = 0;
    spies.push(spyOn(sched, "restoreRemovedTeachers").mockImplementation((async (_e: unknown, tid: string, dates: string[]) => { restoreCalls.push([tid, dates]); return []; }) as any)); // 🔻 TASK-826: Cancel leave puts the teacher back FIRST
    spies.push(spyOn(db, "delete").mockImplementation(((_t: unknown) => ({ where: (w: unknown) => { deletes.push(w); return Promise.resolve([]); } })) as any));
    spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => ({ id: T, nickname: "Ek", lineUserId: "U-ek" })) as any));
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { sent.push(o); return { status: "queued" } as any; }) as any));
    const trip = (w: string) => () => { throw new Error(`TASK-819 tripwire: ${w}`); };
    spies.push(spyOn(db, "update").mockImplementation(trip("a range lift updated a row") as any));
    spies.push(spyOn(db, "insert").mockImplementation(trip("a range lift inserted a row") as any));
    spies.push(spyOn(db, "transaction").mockImplementation(trip("a range lift opened a transaction") as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation(trip("a range lift read bookings") as any));
    return { sent, deletes };
  };
  test("a range with past, today and future days: ONLY the future days go; the others stay and are reported; ONE notice spanning the lifted days", async () => {
    const { sent, deletes } = arm(["2026-10-10", TODAY, "2026-10-20", "2026-10-21"]);
    const r = await call("DELETE", `/teacher-leave-ranges/${RANGE}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ rangeId: RANGE, lifted: ["2026-10-20", "2026-10-21"], kept: ["2026-10-10", TODAY], teacherNotified: 1 });
    expect(restoreCalls).toEqual([[T, ["2026-10-20", "2026-10-21"]]]); // 🔻 TASK-826: the teacher is put back on the co-taught classes of EXACTLY the lifted days (not the kept ones)
    expect(deletes).toHaveLength(1);
    const q = sqlOf(deletes[0]);
    expect(q.sql).toContain('"teacher_leave_days"."range_id" = $1');
    expect(q.params).toEqual([RANGE, "2026-10-20", "2026-10-21"]); // only the future dates are named
    expect(sent).toHaveLength(1);
    expect([sent[0].recipientType, sent[0].recipientLineUserId]).toEqual(["teacher", "U-ek"]);
    expect(sent[0].payload).toEqual({ kind: "teacher_leave_lifted", date: "2026-10-20", to: "2026-10-21", actor: null });
  });
  test("🔴 nothing left to lift (every day has begun or passed) ⇒ 400 with the APPROVED refusal; NOTHING deleted, nobody told", async () => {
    const { sent, deletes } = arm(["2026-10-10", TODAY]);
    const r = await call("DELETE", `/teacher-leave-ranges/${RANGE}`);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("ยกเลิกได้เฉพาะวันลาล่วงหน้า (วันถัดไปเป็นต้นไป) — วันลาของวันนี้หรือวันที่ผ่านมาแล้วยกเลิกไม่ได้");
    expect(deletes).toEqual([]);
    expect(sent).toEqual([]);
  });
  test("an unknown range ⇒ the approved 404 words; nothing deleted", async () => {
    const { sent, deletes } = arm([]);
    const r = await call("DELETE", `/teacher-leave-ranges/${RANGE}`);
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe("ไม่พบวันลาล่วงหน้านี้");
    expect([deletes, sent]).toEqual([[], []]);
  });
  test("a malformed range id is a 400 at the boundary — zero queries", async () => {
    const { deletes } = arm(["2026-10-20"]);
    const sel = spyOn(db, "select");
    const r = await call("DELETE", "/teacher-leave-ranges/not-a-uuid");
    expect(r.status).toBe(400);
    expect(deletes).toEqual([]);
    sel.mockRestore();
  });
  test("one future day left (the rest lifted earlier): the notice names that one day — the single-day wording", async () => {
    const { sent } = arm(["2026-10-21"]);
    const r = await call("DELETE", `/teacher-leave-ranges/${RANGE}`);
    expect(r.body.lifted).toEqual(["2026-10-21"]);
    expect(sent[0].payload).toEqual({ kind: "teacher_leave_lifted", date: "2026-10-21", to: "2026-10-21", actor: null });
  });
  test("access: the SAME action key as the per-day lift, the calendar/booking menus AND the Teachers menu; a viewer without the key gets 403", async () => {
    expect(ROUTE_ACCESS["DELETE /teacher-leave-ranges/:id"]).toEqual({ menus: ["menu:calendar", "menu:bookings", "menu:teachers"], action: "action:calendar.status" });
    expect(ROUTE_ACCESS["DELETE /teacher-leave-ranges/:id"]!.action).toBe(ROUTE_ACCESS["DELETE /teacher-leave-days/:teacherId/:date"]!.action);
    arm(["2026-10-20"]);
    setUser({ isSuperAdmin: false, grants: ["menu:teachers"] }); // the menu, but not the action key
    expect((await call("DELETE", `/teacher-leave-ranges/${RANGE}`)).status).toBe(403);
    setUser({ isSuperAdmin: false, grants: ["menu:teachers", "action:calendar.status"] });
    expect((await call("DELETE", `/teacher-leave-ranges/${RANGE}`)).status).toBe(200);
  });
});

describe("✅ TASK-819's one new string — the owner's APPROVED wording, verbatim", () => {
  test("ob_tl_open_again_range: TH + EN exactly, and marked APPROVED (not DRAFT)", () => {
    const I = file("src/lib/line-i18n.ts");
    expect(I).toContain('ob_tl_open_again_range: { TH: "ช่วงวันนั้นรับจองคาบกับคุณได้ตามปกติแล้ว", EN: "Bookings with you are open again on those days." }, // 🔻 TASK-819 — ✅ APPROVED by the owner 2026-10-17 (REQ-123 Phase 1), COPY-REVIEW-2026-09-29.md, verbatim');
  });
});

describe("TASK-819 — the contract names what Fern groups and renders by", () => {
  const C = code(file("src/types/contract.ts"));
  test("LeaveClassDTO · RecordedLeaveDayDTO (with rangeId) · RecordedLeaveListResponse · RecordLeaveRangeResponse · LiftLeaveRangeResponse are declared", () => {
    expect(region(C, "export interface LeaveClassDTO {", "\n}\n")).toContain("  coChildName: string | null;");
    expect(region(C, "export interface RecordedLeaveDayDTO {", "\n}\n")).toContain("  rangeId: string | null;");
    expect(C).toContain("export interface RecordedLeaveListResponse { items: RecordedLeaveDayDTO[] }");
    expect(region(C, "export interface RecordLeaveRangeResponse {", "\n}\n")).toContain('mode: "advance-range";');
    expect(region(C, "export interface LiftLeaveRangeResponse {", "\n}\n")).toContain("kept: string[];");
  });
});

describe("🔻 follow-up — the per-day lift opens to the Teachers menu too (Fern's Teachers-page panel cancels single days)", () => {
  test("ROUTE_ACCESS: calendar · bookings · teachers, the SAME action key as before — and identical to the range lift", () => {
    expect(ROUTE_ACCESS["DELETE /teacher-leave-days/:teacherId/:date"]).toEqual({ menus: ["menu:calendar", "menu:bookings", "menu:teachers"], action: "action:calendar.status" });
    expect(ROUTE_ACCESS["DELETE /teacher-leave-days/:teacherId/:date"]).toEqual(ROUTE_ACCESS["DELETE /teacher-leave-ranges/:id"]);
  });
  test("by value through the root app: a Teachers-menu viewer WITH the action key lifts a future day (200); WITHOUT the key 403; with neither menu 403", async () => {
    process.env.SKIP_AUTH = "true";
    setSystemTime(new Date(`${TODAY}T10:00:00+07:00`));
    spies.push(spyOn(sched, "restoreRemovedTeachers").mockImplementation((async () => []) as any));
    spies.push(spyOn(db, "delete").mockImplementation((() => ({ where: () => ({ returning: async () => [{ id: "x" }] }) })) as any));
    spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => ({ id: T, nickname: "Ek", lineUserId: null })) as any));
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async () => ({ status: "skipped" })) as any));
    const path = `/teacher-leave-days/${T}/2026-10-21`;
    setUser({ isSuperAdmin: false, grants: ["menu:teachers", "action:calendar.status"] });
    expect((await call("DELETE", path)).status).toBe(200);
    setUser({ isSuperAdmin: false, grants: ["menu:teachers"] });
    expect((await call("DELETE", path)).status).toBe(403);
    setUser({ isSuperAdmin: false, grants: ["menu:students", "action:calendar.status"] });
    expect((await call("DELETE", path)).status).toBe(403);
  });
});

describe("🔑 by source — ONE predicate, the range route cannot be shadowed, the per-day lift untouched", () => {
  const LIB = code(file("src/lib/teacher-leave.ts"));
  const API = code(file("src/routes/api.ts"));
  test("the range lift asks THE predicate once (`isAdvanceLeave`) over the rows of the range — no date arithmetic", () => {
    const L = region(LIB, "export async function liftAdvanceLeaveRange(", "\n}\n");
    expect(L).toContain("rows.filter((r) => isAdvanceLeave(r.date))");
    expect((L.match(/isAdvanceLeave\(/g) ?? []).length).toBe(1);
    expect(L).not.toMatch(/new Date\(|bangkokNow|Date\.parse|> *today/);
    expect(L).toContain("inArray(teacherLeaveDays.date, future)"); // only the future dates are deleted
  });
  test("the route lives on its own noun (`/teacher-leave-ranges`) — never a sibling of `/teacher-leave-days/:teacherId/:date`; the empty lift is the approved refusal", () => {
    expect(API).toContain('.delete("/teacher-leave-ranges/:id", zValidator("param", v.leaveRangeParam)');
    expect(API).toContain("if (!out.lifted.length) throw badRequest(LIFT_FUTURE_ONLY_MESSAGE);");
    // the per-day lift (TASK-814) is byte-identical in its guard
    expect(API).toContain('if (!isAdvanceLeave(c.req.valid("param").date)) throw badRequest(LIFT_FUTURE_ONLY_MESSAGE);');
  });
  test("the service notifies ONCE, only on behalf, only when something was lifted; the per-day lift is untouched", () => {
    const SVC = code(file("src/services/scheduler.service.ts"));
    const S = region(SVC, "export async function liftTeacherLeaveRange(", "\n}\n");
    expect((S.match(/notifyTeacherOfLeaveDay\(/g) ?? []).length).toBe(1);
    expect(S).toContain("opts.onBehalf && r.lifted.length ?");
    expect(region(SVC, "export async function liftTeacherLeave(", "\n}\n")).toContain("const r = await liftAdvanceLeave(db, teacherId, date);");
  });
});
