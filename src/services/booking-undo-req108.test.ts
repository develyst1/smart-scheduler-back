// TASK-492 (SPEC-094) — the admin UNDO, by value, through the REAL `undoBooking`, inside a fake transaction over in-memory rows.
// 🔑 The fake is not a canned answer: every READ runs the service's own `where` callback against recording operators, and every
// UPDATE is judged by its REAL rendered SQL (`WHERE "bookings"."id" = $1 and "bookings"."status" = $2`, `GREATEST(… - 1, 0)`),
// so the conditional guard and the floor are exercised, not assumed. The pure rules are pinned first; then the service; then the
// day-end's exclusion, the leave doors, the migration, the route and the key.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import * as sched from "./scheduler.service";
import * as salePost from "../lib/sale-post";
import { undoBooking } from "./undo.service";
import { UNDO_CHECKIN_CHANNELS, expiryDecision, leaveChargeOf, makeupDecision, notUndoneAttendance, undoKindOf } from "../lib/booking-undo"; // TASK-497: renamed + widened
import { ACTION_KEYS } from "../lib/permissions";
import { SCHEDULING_WITNESSES } from "../lib/migration-witness";
import { readSrc } from "../lib/read-src";
import * as ownScope from "../lib/own-scope"; // TASK-508
import { formatOutboxMessage } from "../lib/line-message";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const src = (f: string) => code(readSrc(readFileSync(resolve(root, f), "utf8")));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });
const errOf = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return { status: e.status, code: e.code, message: e.message as string }; } return null; };

// ───────────────────────── the pure rules ─────────────────────────
describe("✅ the rules, by value (`lib/booking-undo.ts`)", () => {
  test("which Undo: SICK_LEAVE ⇒ leave · ATTENDED by a PARENT's check-in ⇒ checkin · a STAFF attend ⇒ refused (out of scope) · anything else ⇒ refused, naming it", () => {
    expect(undoKindOf({ status: "SICK_LEAVE" })).toBe("leave");
    for (const ch of UNDO_CHECKIN_CHANNELS) expect(undoKindOf({ status: "ATTENDED", checkinChannel: ch })).toBe("checkin");
    expect([...UNDO_CHECKIN_CHANNELS]).toEqual(["checkin-qr", "line", "shopfront-qr"]);
    expect(() => undoKindOf({ status: "ATTENDED", checkinChannel: "staff" })).toThrow("เจ้าหน้าที่");
    for (const s of ["CONFIRMED", "CANCELLED", "PAUSED", "NO_SHOW", "EXTENDED"]) expect(() => undoKindOf({ status: s })).toThrow(`สถานะปัจจุบันคือ ${s}`);
    expect(() => undoKindOf({ status: "ATTENDED", checkinChannel: "end-of-day" })).toThrow("สถานะปัจจุบันคือ ATTENDED");
  });
  test("🔴 did this leave take quota? RECORDED wins; legacy inferred only where certain; else UNKNOWN (refused)", () => {
    expect(leaveChargeOf({ leaveCharged: true, courseId: "c", plannedAtCreation: true }, false)).toBe("charged"); // the record wins
    expect(leaveChargeOf({ leaveCharged: false, courseId: "c" }, true)).toBe("free"); // e.g. an over-quota leave, recorded
    expect(leaveChargeOf({ leaveCharged: null, courseId: null }, false)).toBe("free"); // a voucher/single leave: no quota exists
    expect(leaveChargeOf({ leaveCharged: null, courseId: "c", plannedAtCreation: true }, true)).toBe("free"); // declared at creation
    expect(leaveChargeOf({ leaveCharged: null, courseId: "c", plannedAtCreation: false }, true)).toBe("charged"); // a make-up ⇒ charged
    expect(leaveChargeOf({ leaveCharged: null, courseId: "c", plannedAtCreation: false }, false)).toBe("unknown"); // over-quota? undone attendance? — cannot tell
  });
  test("the make-up: none · the ONE linked live row cancelled · taught / chained / settled / ambiguous / odd ⇒ refused, naming the date", () => {
    const never = () => false;
    expect(makeupDecision([], never)).toEqual({ action: "none" });
    expect(makeupDecision([{ id: "m", status: "EXTENDED", date: "2026-11-06" }], never)).toEqual({ action: "cancel", makeup: { id: "m", status: "EXTENDED", date: "2026-11-06" } });
    expect(() => makeupDecision([{ id: "m", status: "ATTENDED", date: "2026-11-06" }], never)).toThrow("เรียนไปแล้ว");
    expect(() => makeupDecision([{ id: "m", status: "NO_SHOW", date: "2026-11-06" }], never)).toThrow("เรียนไปแล้ว");
    expect(() => makeupDecision([{ id: "m", status: "SICK_LEAVE", date: "2026-11-06" }], never)).toThrow("ถูกแจ้งลาต่อ");
    expect(() => makeupDecision([{ id: "m", status: "EXTENDED", date: "2026-09-20" }], () => true)).toThrow("วันที่ปิดแล้ว");
    expect(() => makeupDecision([{ id: "a", status: "EXTENDED", date: "2026-11-06" }, { id: "b", status: "EXTENDED", date: "2026-11-13" }], never)).toThrow("มากกว่าหนึ่งคาบ (2026-11-06, 2026-11-13)");
    expect(() => makeupDecision([{ id: "m", status: "PAUSED", date: "2026-11-06" }], never)).toThrow("มีสถานะ PAUSED");
  });
  test("🔑 the expiry: keep when the make-up does not hold it; restore ONLY the system's stretch; otherwise STOP and say why", () => {
    const sys = { fromDate: "2026-10-30", toDate: "2026-11-06", actor: null };
    expect(expiryDecision({ expiry: "2026-11-20", makeupDate: "2026-11-06", otherDates: [], latest: sys })).toEqual({ action: "keep" });
    expect(expiryDecision({ expiry: "2026-11-06", makeupDate: "2026-11-06", otherDates: ["2026-11-06"], latest: null })).toEqual({ action: "keep" }); // still needed
    expect(expiryDecision({ expiry: "2026-11-06", makeupDate: "2026-11-06", otherDates: ["2026-10-23"], latest: sys })).toEqual({ action: "restore", from: "2026-11-06", to: "2026-10-30" });
    const stop = (latest: any, other = ["2026-10-23"]) => () => expiryDecision({ expiry: "2026-11-06", makeupDate: "2026-11-06", otherDates: other, latest });
    expect(stop(null)).toThrow("กำหนดตั้งแต่เปิดคอร์ส");
    expect(stop({ ...sys, actor: "admin-dong" })).toThrow("เลื่อนโดย admin-dong");
    expect(stop({ ...sys, toDate: "2026-11-13" })).toThrow("ไม่ใช่ของคาบขยายนี้");
    expect(stop(sys, ["2026-11-02"])).toThrow("มีคาบหลังวันที่ 2026-10-30");
  });
});

// ───────────────────────── the service, over a fake transaction ─────────────────────────
const dialect = new PgDialect();
const camel = (s: string) => s.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
const TABLE_KEY: Record<string, string> = { bookings: "bookings", course_packages: "coursePackages", vouchers: "vouchers", booking_undos: "undos", notification_outbox: "outbox" }; // TASK-508: + the outbox
const ops = {
  and: (...a: any[]) => a.flat(), eq: (c: string, v: unknown) => ({ op: "eq", c, v }), ne: (c: string, v: unknown) => ({ op: "ne", c, v }),
  notInArray: (c: string, v: unknown[]) => ({ op: "notIn", c, v }), isNull: (c: string) => ({ op: "isNull", c }),
};
const cols = new Proxy({}, { get: (_t, k) => String(k) }) as any;
const matches = (row: any, where?: any) => !where || [where(cols, ops)].flat(5).every((w: any) =>
  w.op === "eq" ? row[w.c] === w.v : w.op === "ne" ? row[w.c] !== w.v : w.op === "notIn" ? !w.v.includes(row[w.c]) : w.op === "isNull" ? row[w.c] == null : true);

type World = { bookings: any[]; coursePackages: any[]; vouchers: any[]; jobRuns: any[]; changes: any[]; students: any[]; undos: any[]; writes: string[]; teachers: Array<{ id: string; lineUserId: string | null }>; coTeachers: Record<string, string[]>; outbox: any[] };
const TODAY = "2026-09-26";
const world = (over: Partial<World> = {}): World => ({
  bookings: [], coursePackages: [{ id: "c1", size: 4, leaveUsed: 2, usedSessions: 1, expiryDate: "2026-11-06", endedAt: null, droppedAt: null }],
  vouchers: [{ id: "v1", usedHours: 3 }], jobRuns: [], changes: [], students: [{ id: "s1", name: "Feen Full", nickname: "Feen" }, { id: "s2", name: "Mew Full", nickname: "Mew" }],
  undos: [], writes: [], teachers: [{ id: "t1", lineUserId: "U-coach-t1" }], coTeachers: {}, outbox: [], ...over, // TASK-508: the coaches (t1 primary) + the outbox
});
const B = (id: string, date: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, date, status, startTime: "10:00:00", teacherId: "t1", studentId: "s1", coStudentId: null, courseId: "c1", voucherId: null, bookingType: "COURSE_PACKAGE",
  extendedFromId: null, plannedAtCreation: false, leaveCharged: null, groupId: null, slotYieldedAt: null, otherTitle: null, campWeekDayId: null,
  checkinChannel: null, checkinActor: null, checkinSource: null, ...extra,
});
/** A four-session course: b1 a CHARGED leave whose make-up m1 (11-06) stretched the expiry from 10-30 — the system's stretch. */
const leaveWorld = (over: Partial<World> = {}) => world({
  bookings: [B("b1", "2026-10-02", "SICK_LEAVE", { leaveCharged: true }), B("b2", "2026-10-09", "CONFIRMED"), B("b3", "2026-10-16", "CONFIRMED"), B("b4", "2026-10-23", "CONFIRMED"),
    B("m1", "2026-11-06", "EXTENDED", { extendedFromId: "b1" })],
  changes: [{ courseId: "c1", fromDate: "2026-10-30", toDate: "2026-11-06", actor: null, changedAt: new Date("2026-09-20T00:00:00Z") }],
  ...over,
});

type Harness = { w: World; holds: Array<[string, string]>; expiry: any[]; reversed: string[]; staleRead?: any; coachesAsked: string[] };
const run = (w: World, opts: { plan?: { appended: string[]; cancelled: string[] }; stale?: Record<string, any> } = {}) => {
  const h: Harness = { w, holds: [], expiry: [], reversed: [], coachesAsked: [] };
  const withRels = (r: any) => r && ({ ...r, course: w.coursePackages.find((c) => c.id === r.courseId) ?? null, voucher: w.vouchers.find((v) => v.id === r.voucherId) ?? null,
    student: w.students.find((s) => s.id === r.studentId) ?? null, coStudent: w.students.find((s) => s.id === r.coStudentId) ?? null });
  const table = (rows: () => any[], rel = (r: any) => r) => ({
    findFirst: async (q: any) => { const hit = rows().find((r) => matches(r, q?.where)); return hit ? rel(opts.stale?.[hit.id] ?? hit) : undefined; },
    findMany: async (q: any) => rows().filter((r) => matches(r, q?.where)).map(rel),
  });
  const applySet = (row: any, set: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(set)) {
      if (v && typeof v === "object" && "queryChunks" in (v as object)) {
        const s = dialect.sqlToQuery(v as any).sql;
        row[k] = /^GREATEST\(".+?"\."\w+" - 1, 0\)$/.test(s) ? Math.max(0, row[k] - 1) : / \+ 1$/.test(s) ? row[k] + 1 : (() => { throw new Error(`unhandled SQL in set: ${s}`); })();
      } else row[k] = v;
    }
  };
  const tx = {
    query: {
      bookings: table(() => w.bookings, withRels),
      coursePackages: table(() => w.coursePackages),
      jobRuns: table(() => w.jobRuns),
      courseExpiryChanges: { findFirst: async (q: any) => [...w.changes].filter((r) => matches(r, q?.where)).sort((a, b) => +b.changedAt - +a.changedAt)[0] },
    },
    update: (t: any) => ({ set: (set: Record<string, unknown>) => ({ where: (cond: any) => {
      const { sql, params } = dialect.sqlToQuery(cond);
      const conds = [...sql.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)].map((m) => ({ col: camel(m[2]!), val: params[Number(m[3]) - 1] }));
      if (!/^\(?("\w+"\."\w+" = \$\d+( and )?)+\)?$/.test(sql)) throw new Error(`unhandled WHERE: ${sql}`);
      const key = TABLE_KEY[getTableName(t)]!;
      const hits = (w as any)[key].filter((r: any) => conds.every((c) => r[c.col] === c.val));
      for (const r of hits) { applySet(r, set); w.writes.push(`${key}:${r.id}:${Object.keys(set).join(",")}`); }
      const out = hits.map((r: any) => ({ id: r.id }));
      return Object.assign(Promise.resolve(out), { returning: async () => out });
    } }) }),
    insert: (t: any) => ({ values: async (v: any) => { const key = TABLE_KEY[getTableName(t)] ?? getTableName(t); (w as any)[key]?.push?.(v); w.writes.push(`insert:${key}`); } }),
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (cb: any) => cb(tx)) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async (_tx: any, id: string, _t: string, status: string) => { h.holds.push([id, status]); }) as any));
  spies.push(spyOn(sched, "reconcileCoursePlan").mockImplementation((async () => opts.plan ?? { appended: [], cancelled: [] }) as any));
  spies.push(spyOn(sched, "recordExpiryChange").mockImplementation((async (_tx: any, row: any) => { h.expiry.push(row); }) as any));
  spies.push(spyOn(sched, "loadBookingDTO").mockImplementation((async (_e: any, id: string) => ({ id })) as any));
  // TASK-508 — the coaches of a row: its primary + its additional teachers (`booking_teachers`), answered from the world. The
  // predicate itself is pinned by its rendered SQL below; here the question is only WHO gets told.
  spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async (_e: any, id: string) => {
    h.coachesAsked.push(id);
    const b = w.bookings.find((x) => x.id === id);
    const ids = [b?.teacherId, ...(w.coTeachers[id] ?? [])].filter(Boolean);
    return w.teachers.filter((t) => ids.includes(t.id));
  }) as any));
  spies.push(spyOn(salePost, "reverseBookingSale").mockImplementation((async (id: string) => { h.reversed.push(id); return { posted: false } as any; }) as any));
  setSystemTime(new Date(`${TODAY}T10:00:00+07:00`));
  return h;
};
const row = (w: World, id: string) => w.bookings.find((b) => b.id === id);

describe("🔴 a mistaken LEAVE — back to CONFIRMED, its quota refunded ONCE, ITS make-up removed, the expiry restored exactly", () => {
  test("by value: status · leave_used 2 → 1 · m1 CANCELLED · expiry 11-06 → 10-30 (audited, with the actor) · holds · ONE record · no other write", async () => {
    const h = run(leaveWorld());
    const out = await undoBooking("b1", { actor: "admin-dong", reason: "wrong child" });
    expect(out as unknown).toEqual({ kind: "leave", leaveRefunded: true, makeupCancelledId: "m1", expiry: { from: "2026-11-06", to: "2026-10-30" }, booking: { id: "b1" } });
    expect([row(h.w, "b1").status, row(h.w, "b1").leaveCharged, row(h.w, "m1").status]).toEqual(["CONFIRMED", null, "CANCELLED"]);
    expect([h.w.coursePackages[0].leaveUsed, h.w.coursePackages[0].expiryDate]).toEqual([1, "2026-10-30"]);
    expect(h.expiry).toEqual([{ courseId: "c1", from: "2026-11-06", to: "2026-10-30", actor: "admin-dong" }]);
    expect(h.holds).toEqual([["m1", "CANCELLED"], ["b1", "CONFIRMED"]]);
    expect(h.w.undos).toEqual([{ bookingId: "b1", kind: "leave", undoneBy: "admin-dong", reason: "wrong child", priorStatus: "SICK_LEAVE", priorCheckinChannel: null, priorCheckinActor: null, leaveRefunded: true, makeupCancelledId: "m1", expiryFrom: "2026-11-06", expiryTo: "2026-10-30" }]);
    // 🚫 nothing else touched: the inserts are the record — and, since TASK-508 (owner: yes), ONE message to the coach that the
    // class is on again. (Was `["insert:undos"]`, "silent": the owner has since ruled the coach IS told; the family never is —
    // pinned by value in TASK-508's block below.)
    // 🔻 TASK-510 — and the make-up m1 it cancelled tells ITS coach the class is off (first), then b1's coach it is on again.
    expect(h.w.writes.filter((x) => x.startsWith("insert:"))).toEqual(["insert:outbox", "insert:outbox", "insert:undos"]);
    expect(h.w.outbox.map((m) => [m.bookingId, m.payload.kind])).toEqual([["m1", "class_cancelled_teacher"], ["b1", "class_on_again_teacher"]]);
    expect(h.reversed).toEqual([]);
  });
  test("🔑 the guard: a SECOND Undo that read the row before the first committed (a double-click, two admins) touches ZERO rows and refunds NOTHING", async () => {
    const w = leaveWorld();
    const snapshot = { ...row(w, "b1") }; // what the second request read — SICK_LEAVE
    run(w);
    await undoBooking("b1", { actor: "a", reason: null });
    for (const s of spies.splice(0)) s.mockRestore();
    const h2 = run(w, { stale: { b1: snapshot } });
    const before = h2.w.writes.length;
    expect(await errOf(undoBooking("b1", { actor: "b", reason: null }))).toMatchObject({ status: 409, code: "UNDO_ALREADY_CHANGED" });
    expect(h2.w.coursePackages[0].leaveUsed).toBe(1); // refunded ONCE
    expect(h2.w.undos.length).toBe(1);
    expect(h2.w.writes.slice(before)).toEqual([]); // the conditional update matched nothing, and nothing followed it
  });
  test("the floor: a refund on a course already at 0 stays 0 (never negative, never free leave)", async () => {
    const h = run(leaveWorld({ coursePackages: [{ id: "c1", size: 4, leaveUsed: 0, usedSessions: 1, expiryDate: "2026-11-06", endedAt: null, droppedAt: null }] }));
    await undoBooking("b1", { actor: "a", reason: null });
    expect(h.w.coursePackages[0].leaveUsed).toBe(0);
  });
  test("🔴 an OVER-QUOTA leave (recorded false) is NOT refunded; a DECLARED-AT-CREATION legacy leave is NOT refunded", async () => {
    for (const b1 of [B("b1", "2026-10-02", "SICK_LEAVE", { leaveCharged: false }), B("b1", "2026-10-02", "SICK_LEAVE", { leaveCharged: null, plannedAtCreation: true })]) {
      for (const s of spies.splice(0)) s.mockRestore();
      const h = run(world({ bookings: [b1, B("b2", "2026-10-09", "CONFIRMED")] }));
      const out = await undoBooking("b1", { actor: "a", reason: null });
      expect([out.leaveRefunded, h.w.coursePackages[0].leaveUsed, row(h.w, "b1").status]).toEqual([false, 2, "CONFIRMED"]);
    }
  });
  test("a legacy leave with a linked make-up is refunded; one that cannot be told ⇒ REFUSED, nothing written", async () => {
    const legacy = leaveWorld();
    legacy.bookings[0].leaveCharged = null;
    let h = run(legacy);
    expect((await undoBooking("b1", { actor: "a", reason: null })).leaveRefunded).toBe(true);
    for (const s of spies.splice(0)) s.mockRestore();
    h = run(world({ bookings: [B("b1", "2026-10-02", "SICK_LEAVE", { leaveCharged: null })] }));
    expect(await errOf(undoBooking("b1", { actor: "a", reason: null }))).toMatchObject({ code: "UNDO_LEAVE_CHARGE_UNKNOWN" });
    expect([h.w.writes, row(h.w, "b1").status, h.w.coursePackages[0].leaveUsed]).toEqual([[], "SICK_LEAVE", 2]);
  });
  test("🔴 THIS leave's make-up — never another leave's, even when the other one is newer", async () => {
    const w = leaveWorld();
    w.bookings.push(B("b5", "2026-10-30", "SICK_LEAVE", { leaveCharged: true }), B("m2", "2026-11-13", "EXTENDED", { extendedFromId: "b5" }));
    w.coursePackages[0].expiryDate = "2026-11-13";
    const h = run(w);
    const out = await undoBooking("b1", { actor: "a", reason: null });
    expect([row(h.w, "m1").status, row(h.w, "m2").status, out.makeupCancelledId, out.expiry]).toEqual(["CANCELLED", "EXTENDED", "m1", null]); // m1 did not hold the expiry
  });
  test("refusals — each names what it refused, and writes NOTHING: a taught make-up · an admin-set expiry · the hour re-booked · the plan would change", async () => {
    const cases: Array<[string, (w: World) => void, string, string?]> = [
      ["taught", (w) => { row(w, "m1").status = "ATTENDED"; }, "UNDO_MAKEUP_TAUGHT", "2026-11-06"],
      ["admin expiry", (w) => { w.changes[0].actor = "admin-dong"; }, "UNDO_EXPIRY_UNRECOVERABLE", "เลื่อนโดย admin-dong"],
      ["hour taken", (w) => { w.bookings.push(B("x9", "2026-10-02", "CONFIRMED", { studentId: "s2", courseId: null })); }, "UNDO_SLOT_TAKEN", "2026-10-02 10:00 ของครูมีคาบของ Mew"],
    ];
    for (const [, mutate, code_, words] of cases) {
      for (const s of spies.splice(0)) s.mockRestore();
      const w = leaveWorld(); mutate(w);
      const h = run(w);
      const e = await errOf(undoBooking("b1", { actor: "a", reason: null }));
      expect({ code: e?.code, named: words ? e!.message.includes(words) : true }).toEqual({ code: code_, named: true });
      expect(h.w.writes).toEqual([]);
    }
    for (const s of spies.splice(0)) s.mockRestore();
    run(leaveWorld(), { plan: { appended: [], cancelled: ["m-other"] } });
    expect(await errOf(undoBooking("b1", { actor: "a", reason: null }))).toMatchObject({ code: "UNDO_PLAN_WOULD_CHANGE" }); // (the real transaction rolls back)
  });
  test("a leave's OWN slot is not its obstacle; a slot held by a cancelled or on-leave row is free (the index's own list)", async () => {
    const w = leaveWorld();
    w.bookings.push(B("x1", "2026-10-02", "CANCELLED", { courseId: null }), B("x2", "2026-10-02", "SICK_LEAVE", { courseId: null, leaveCharged: false }));
    run(w);
    expect((await undoBooking("b1", { actor: "a", reason: null })).kind).toBe("leave");
  });
});

describe("🔨 SETTLED is a hard refusal (owner, Q1) — before today, or the day-end ran for that date", () => {
  test("yesterday ⇒ refused · today after a successful end-of-day ⇒ refused · today before it (or after a FAILED run) ⇒ allowed", async () => {
    let h = run(world({ bookings: [B("b1", "2026-09-25", "SICK_LEAVE", { leaveCharged: false, courseId: null })] }));
    expect(await errOf(undoBooking("b1", { actor: "a", reason: null }))).toMatchObject({ code: "UNDO_DAY_SETTLED", message: expect.stringContaining("2026-09-25") });
    expect(h.w.writes).toEqual([]);
    for (const s of spies.splice(0)) s.mockRestore();
    h = run(world({ bookings: [B("b1", TODAY, "SICK_LEAVE", { leaveCharged: false, courseId: null })], jobRuns: [{ job: "end-of-day", runDate: TODAY, status: "success" }] }));
    expect(await errOf(undoBooking("b1", { actor: "a", reason: null }))).toMatchObject({ code: "UNDO_DAY_SETTLED" });
    for (const s of spies.splice(0)) s.mockRestore();
    h = run(world({ bookings: [B("b1", TODAY, "SICK_LEAVE", { leaveCharged: false, courseId: null })], jobRuns: [{ job: "end-of-day", runDate: TODAY, status: "failed" }] }));
    expect((await undoBooking("b1", { actor: "a", reason: null })).kind).toBe("leave");
  });
  test("an ENDED or PAUSED course refuses (the ONE guard, `assertCourseWritable`)", async () => {
    for (const [k, code_] of [["endedAt", "COURSE_ENDED"], ["droppedAt", "COURSE_DROPPED"]] as const) {
      for (const s of spies.splice(0)) s.mockRestore();
      const w = leaveWorld(); (w.coursePackages[0] as any)[k] = new Date("2026-09-01T00:00:00Z");
      const h = run(w);
      expect(await errOf(undoBooking("b1", { actor: "a", reason: null }))).toMatchObject({ code: code_ });
      expect(h.w.writes).toEqual([]);
    }
  });
});

describe("🔴 a FALSE CHECK-IN — back to CONFIRMED, the unit returned, SILENT, its provenance kept on the record", () => {
  const checkedIn = (extra: Record<string, unknown> = {}) => world({ bookings: [B("b1", TODAY, "ATTENDED", { checkinChannel: "shopfront-qr", checkinActor: null, checkinSource: "shopfront-qr", ...extra })] });
  test("by value: CONFIRMED · used_sessions 1 → 0 · the row's check-in columns cleared · the record keeps them · the sale reversed AFTER · no message", async () => {
    const h = run(checkedIn());
    const out = await undoBooking("b1", { actor: "admin-dong", reason: "tapped the wrong child" });
    expect(out as unknown).toEqual({ kind: "checkin", leaveRefunded: false, makeupCancelledId: null, expiry: null, booking: { id: "b1" } });
    expect([row(h.w, "b1").status, row(h.w, "b1").checkinChannel, row(h.w, "b1").checkinSource, h.w.coursePackages[0].usedSessions]).toEqual(["CONFIRMED", null, null, 0]);
    expect(h.w.undos[0]).toMatchObject({ kind: "checkin", priorStatus: "ATTENDED", priorCheckinChannel: "shopfront-qr", undoneBy: "admin-dong" });
    expect(h.reversed).toEqual(["b1"]);
    expect(h.w.writes.filter((x) => x.startsWith("insert:"))).toEqual(["insert:undos"]); // 🚫 no outbox row: silent (owner ruling 2)
    expect(h.holds).toEqual([["b1", "CONFIRMED"]]);
  });
  test("a voucher's hour comes back instead, floored", async () => {
    const h = run(checkedIn({ courseId: null, voucherId: "v1", bookingType: "VOUCHER" }));
    await undoBooking("b1", { actor: "a", reason: null });
    expect([h.w.vouchers[0].usedHours, h.w.coursePackages[0].usedSessions]).toEqual([2, 1]);
  });
  test("a STAFF attend is refused (TASK-258 is its own finding) — nothing written", async () => {
    const h = run(checkedIn({ checkinChannel: "staff", checkinActor: "admin-dong" }));
    expect(await errOf(undoBooking("b1", { actor: "a", reason: null }))).toMatchObject({ code: "UNDO_STAFF_ATTEND" });
    expect(h.w.writes).toEqual([]);
  });
  test("🔴 the day-end then leaves it alone: its `due` select carries `notUndoneAttendance()`, which reads the append-only record", () => {
    // 🔻 TASK-497 — renamed from `notUndoneCheckin` and widened: an undone STAFF / DAY-END mark (`attendance`) is exempt too.
    const { sql } = dialect.sqlToQuery(notUndoneAttendance());
    expect(sql).toBe(`not exists (select 1 from "booking_undos" where "booking_undos"."booking_id" = "bookings"."id" and "booking_undos"."kind" in ('checkin', 'attendance'))`);
    const JOB = src("src/services/jobs.service.ts");
    const due = JOB.slice(JOB.indexOf("const due = await tx"), JOB.indexOf("let coursesAutoAttended"));
    expect(due).toContain('.where(and(eq(bookings.date, runDate), eq(bookings.status, "CONFIRMED"), ended, notUndoneAttendance()));');
  });
});

describe("🔑 by source — the leave doors RECORD the charge; every counter moves by `sql`; the guard comes first", () => {
  const S = src("src/services/scheduler.service.ts");
  test("Door 1 · Door 2 · TASK-258 · the creation flip each write `leaveCharged`, and both increments are `sql` (no read-modify-write)", () => {
    expect(S).toContain('.set({ status: "SICK_LEAVE", note: change.reason ?? b.note, leaveCharged: !b.plannedAtCreation })');
    expect(S).toContain("const charges = !!(current.courseId && current.course && canTakeLeave(current.course) && !current.plannedAtCreation);");
    expect(S).toContain('.set({ status: "SICK_LEAVE", note: reason ?? current.note, leaveCharged: charges })');
    // 🔻 TASK-497 — TASK-258's door no longer writes SICK_LEAVE (owner: CONFIRMED); it writes no `leaveCharged` because it writes no leave.
    expect(S).toContain("await revertAttendance(tx, current, { note: reason ?? current.note });");
    expect(S).not.toContain('.set({ status: "SICK_LEAVE", note: reason ?? current.note, leaveCharged: false })');
    expect(S).toContain('set({ status: "SICK_LEAVE", plannedAtCreation: true, leaveCharged: false })');
    expect((S.match(/leaveUsed: sql`\$\{coursePackages\.leaveUsed\} \+ 1`/g) ?? []).length).toBe(2);
    expect(S).not.toMatch(/leaveUsed: (course|current\.course)\.leaveUsed \+ 1/);
  });
  test("the Undo: every counter `GREATEST(… - 1, 0)`; the conditional guard is its FIRST write; the sale reversal is after the transaction", () => {
    const U = src("src/services/undo.service.ts");
    // 🔻 TASK-497 — the check-in's two decrements moved to the SHARED writer; still three, still floored.
    const REV = src("src/services/attendance-revert.service.ts");
    expect([(U.match(/sql`GREATEST\(\$\{/g) ?? []).length, (REV.match(/sql`GREATEST\(\$\{/g) ?? []).length]).toEqual([1, 2]);
    // nothing is written before the guard's conditional update — every earlier line is a read
    expect(U.slice(0, U.indexOf(".where(and(eq(bookings.id, row.id), eq(bookings.status, row.status)))"))).not.toMatch(/tx\.update\(|tx\.insert\(|reconcileBookingHolds\(|reconcileCoursePlan\(/);
    expect(U.indexOf("await reverseBookingSale(bookingId)")).toBeGreaterThan(U.indexOf("return { kind, leaveRefunded"));
    // 🔻 TASK-508 — was `not.toMatch(/notify|enqueueLine|sendLeaveNotice|pushMessage/)` ("silent"). The owner has since ruled the COACH is
    // told on a leave Undo: exactly ONE send remains, after the guard — its recipients and its silence on a check-in are pinned by value below.
    expect(U).not.toMatch(/notify|sendLeaveNotice|pushMessage/);
    expect(U.match(/enqueueLine\(/g)).toHaveLength(1);
    expect(U.indexOf("await enqueueLine(")).toBeGreaterThan(U.indexOf(".where(and(eq(bookings.id, row.id), eq(bookings.status, row.status)))"));
    expect(U).toContain("await assertCourseWritable(tx, row.courseId);");
  });
});

describe("✅ the migration, the key, the route", () => {
  test("0058: the column, the append-only table, the index LAST = the witness; journal `when` in series", () => {
    const SQL = readFileSync(resolve(root, "drizzle/0058_booking_undo.sql"), "utf8");
    const stmts = SQL.split("--> statement-breakpoint").map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim()).filter(Boolean);
    expect(stmts.length).toBe(3);
    expect(stmts[0]).toBe('ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "leave_charged" boolean;');
    expect(stmts[1]).toStartWith('CREATE TABLE IF NOT EXISTS "booking_undos" (');
    expect(stmts[1]).toContain(`CONSTRAINT "booking_undos_kind_chk" CHECK ("kind" IN ('leave', 'checkin'))`);
    expect(stmts[2]).toBe('CREATE INDEX IF NOT EXISTS "booking_undos_booking_idx" ON "booking_undos" ("booking_id", "kind");');
    expect(SQL).not.toMatch(/^\s*(UPDATE|DROP)/m); // no backfill, nothing dropped
    expect(SCHEDULING_WITNESSES.find((w) => w.tag === "0058_booking_undo")?.probe).toEqual({ kind: "index", index: "booking_undos_booking_idx" });
    // 🔻 TASK-497 — was `.entries.at(-1)`: 0059 is the newest now, so 0058 is found by its tag (its entry unchanged, byte for byte).
    const J = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")).entries.find((e: any) => e.tag === "0058_booking_undo");
    expect(J).toEqual({ idx: 58, version: "7", when: 1783000000054, tag: "0058_booking_undo", breakpoints: true });
  });
  test("🔴 TASK-497 · 0059: ONLY the kind CHECK gains `attendance` — dropped-if-exists, re-added NOT VALID, validated; witness by DEFINITION; `when` next in series", () => {
    const SQL = readFileSync(resolve(root, "drizzle/0059_attendance_undo_kind.sql"), "utf8");
    const stmts = SQL.split("--> statement-breakpoint").map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim()).filter(Boolean);
    expect(stmts).toEqual([
      'ALTER TABLE "booking_undos" DROP CONSTRAINT IF EXISTS "booking_undos_kind_chk";',
      `ALTER TABLE "booking_undos" ADD CONSTRAINT "booking_undos_kind_chk" CHECK ("kind" IN ('leave', 'checkin', 'attendance')) NOT VALID;`,
      'ALTER TABLE "booking_undos" VALIDATE CONSTRAINT "booking_undos_kind_chk";',
    ]);
    expect(SQL).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)/m); // no backfill
    // the witness: a NAME probe would pass on 0058's old constraint — only the DEFINITION proves this file ran
    expect(SCHEDULING_WITNESSES.find((w) => w.tag === "0059_attendance_undo_kind")?.probe).toEqual({ kind: "constraint-def", constraint: "booking_undos_kind_chk", contains: "attendance" });
    expect(JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")).entries.at(-1)).toEqual({ idx: 59, version: "7", when: 1783000000055, tag: "0059_attendance_undo_kind", breakpoints: true });
    // the schema agrees with the file (the CHECK and the column's type)
    const SCH = src("src/db/schema.ts");
    expect(SCH).toContain("check(\"booking_undos_kind_chk\", sql`${t.kind} IN ('leave', 'checkin', 'attendance')`),");
    expect(SCH).toContain('kind: text("kind").$type<"leave" | "checkin" | "attendance">().notNull(),');
  });
  test("the 60th key, its own; the route gated by it; a linked account refused before the service", () => {
    expect(ACTION_KEYS).toContain("action:calendar.undo");
    expect(ACTION_KEYS.length).toBe(60);
    expect(src("src/lib/route-access.ts")).toContain('"POST /bookings/:id/undo": act(CAL_BOOK, "action:calendar.undo"),');
    const API = src("src/routes/api.ts");
    const route = API.slice(API.indexOf('.post("/bookings/:id/undo"'), API.indexOf('.patch("/bookings/:id", zValidator'));
    expect(route.indexOf("if (isScoped(c.get(\"user\"))) throw SCOPE_TEACHER();")).toBeLessThan(route.indexOf("undo.undoBooking("));
    expect(route).toContain("actor: actorOf(c)");
  });
});

// ───────────────────────── TASK-508 — the coach is told when a LEAVE is undone; nobody on a check-in; never the family ─────────────────────────
describe("🔔 TASK-508 — a LEAVE Undo tells EVERY coach of the class that it is on again; a check-in Undo tells nobody; the family never", () => {
  const coTaught = () => leaveWorld({
    teachers: [{ id: "t1", lineUserId: "U-coach-t1" }, { id: "t2", lineUserId: "U-coach-t2" }, { id: "t9", lineUserId: "U-coach-t9" }],
    coTeachers: { b1: ["t2"], m1: ["t9"] }, // t9 teaches only the make-up — not this class
  });
  const onAgain = (to: string | null) => ({
    recipientType: "teacher", recipientLineUserId: to, bookingId: "b1",
    payload: { kind: "class_on_again_teacher", bookingId: "b1", bookingType: "COURSE_PACKAGE", size: 4 },
    ...(to ? { status: "PENDING", idempotencyKey: null } : { status: "SKIPPED", error: "no line userId" }),
  });

  test("🔑 by value: the PRIMARY and the ADDITIONAL teacher each get one row — nobody else, and no parent", async () => {
    const h = run(coTaught());
    await undoBooking("b1", { actor: "admin-dong", reason: null });
    expect(h.coachesAsked).toEqual(["m1", "b1"]); // the make-up's coaches (TASK-510), then THIS class's — once each
    expect(h.w.outbox.filter((m) => m.payload.kind === "class_on_again_teacher")).toEqual([onAgain("U-coach-t1"), onAgain("U-coach-t2")]);
    expect(h.w.outbox.filter((m) => m.recipientType !== "teacher")).toEqual([]); // 🚫 never the family
  });

  test("📌 an UNLINKED coach gets NOTHING delivered — a SKIPPED row records that they could not be told (the Undo still succeeds)", async () => {
    const w = coTaught();
    w.teachers[1]!.lineUserId = null;
    const h = run(w);
    expect((await undoBooking("b1", { actor: "a", reason: null })).kind).toBe("leave");
    expect(h.w.outbox.filter((m) => m.payload.kind === "class_on_again_teacher")).toEqual([onAgain("U-coach-t1"), onAgain(null)]);
    expect(row(h.w, "b1").status).toBe("CONFIRMED");
  });

  test("🚫 a FALSE CHECK-IN Undo sends NOTHING — no coach asked, no row (the owner's silent case: the class was never off)", async () => {
    const w = world({ bookings: [B("b1", TODAY, "ATTENDED", { checkinChannel: "line", checkinSource: "line" })], coTeachers: { b1: ["t2"] }, teachers: [{ id: "t1", lineUserId: "U-coach-t1" }, { id: "t2", lineUserId: "U-coach-t2" }] });
    const h = run(w);
    expect((await undoBooking("b1", { actor: "a", reason: null })).kind).toBe("checkin");
    expect([h.coachesAsked, h.w.outbox]).toEqual([[], []]);
  });

  test("a REFUSED leave Undo queues nothing (the send sits after every refusal; the real transaction also rolls it back)", async () => {
    const h = run(coTaught(), { plan: { appended: [], cancelled: ["m-other"] } });
    expect(await errOf(undoBooking("b1", { actor: "a", reason: null }))).toMatchObject({ code: "UNDO_PLAN_WOULD_CHANGE" });
    expect(h.w.outbox).toEqual([]);
  });

  test("🔑 WHO is a coach of the row: THE predicate (TASK-487), by its rendered SQL — the primary OR an additional teacher", async () => {
    let join: any = null;
    const exec = { select: (_f: any) => ({ from: (_t: any) => ({ innerJoin: async (_t2: any, cond: any) => { join = dialect.sqlToQuery(cond); return []; } }) }) };
    for (const s of spies.splice(0)) s.mockRestore(); // the REAL teachersOfBooking
    await ownScope.teachersOfBooking(exec, "b1");
    expect(join.sql).toBe('("bookings"."id" = $1 and ("bookings"."teacher_id" = "teachers"."id" or exists (select 1 from "booking_teachers" where ("booking_teachers"."booking_id" = "bookings"."id" and "booking_teachers"."teacher_id" = "teachers"."id"))))');
    expect(join.params).toEqual(["b1"]);
  });

  test("the words, by value — a coach between classes reads: the class is ON, which child, when (TH and EN: the house's bilingual stamp, English labels)", () => {
    const CTX = { studentName: "มะขิด", subject: "Freeskate", date: "2026-10-02", startTime: "10:00", endTime: "11:00", coach: "Ek" };
    const th = formatOutboxMessage({ kind: "class_on_again_teacher", bookingType: "COURSE_PACKAGE", size: 4 } as any, CTX as any, "TH", "teacher");
    expect(th.split("\n")).toEqual([
      "CLASS ON AGAIN / มีคาบตามเดิม ‼️",
      "Student : มะขิด",
      "Program : Freeskate 4 HR",
      "Date : 02-10-2026",
      "Time : 10:00-11:00",
      "Coach : Ek",
    ]);
    expect(formatOutboxMessage({ kind: "class_on_again_teacher", bookingType: "COURSE_PACKAGE", size: 4 } as any, CTX as any, "EN", "teacher")).toBe(th);
    expect(th).not.toMatch(/undo|ย้อนกลับ|ยกเลิกการลา/i); // 🚫 not our word for our own act
  });

  test("📌 by source: the send is INSIDE the leave branch's transaction, after the plan check — and the file names no parent recipient", () => {
    const U = src("src/services/undo.service.ts");
    const leave = U.slice(U.indexOf("if (moves.appended.length || moves.cancelled.length) throw UNDO_PLAN_WOULD_CHANGE();"), U.indexOf("} else {\n      // The false check-in"));
    expect(leave).toContain("for (const coach of await teachersOfBooking(tx, row.id)) {");
    expect(leave).toContain("}, tx);");
    expect(U).not.toContain('recipientType: "parent"');
    expect(U.match(/enqueueLine\(/g)).toHaveLength(1);
  });
});

// ───────────────────────── TASK-510 — the leave Undo's cancelled MAKE-UP tells ITS coaches; the leave + cancel notices reach EVERY coach ─────────────────────────
describe("🔴 TASK-510 — every coach of a class is told when it stops happening (co-taught fixtures, by value)", () => {
  const makeupOff = (bookingId: string, to: string | null) => ({
    recipientType: "teacher", recipientLineUserId: to, bookingId,
    payload: { kind: "class_cancelled_teacher", bookingId, bookingType: "COURSE_PACKAGE", size: 4, cancelReason: null, note: "ยกเลิกคาบขยาย — ย้อนกลับการลา" },
    ...(to ? { status: "PENDING", idempotencyKey: null } : { status: "SKIPPED", error: "no line userId" }),
  });

  test("🔑 the make-up is held by a DIFFERENT coach (t9): t9 is told THE MAKE-UP is off; b1's coach is told b1 is on; nobody crosses over; no parent", async () => {
    const w = leaveWorld({ teachers: [{ id: "t1", lineUserId: "U-coach-t1" }, { id: "t9", lineUserId: "U-coach-t9" }] });
    row(w, "m1").teacherId = "t9";
    const h = run(w);
    await undoBooking("b1", { actor: "a", reason: null });
    expect(h.w.outbox.map((m) => [m.recipientLineUserId, m.bookingId, m.payload.kind])).toEqual([
      ["U-coach-t9", "m1", "class_cancelled_teacher"], // the make-up's coach: THAT class is off
      ["U-coach-t1", "b1", "class_on_again_teacher"], // this class's coach: it is on again
    ]);
    expect(h.w.outbox[0]).toEqual(makeupOff("m1", "U-coach-t9"));
    expect(h.w.outbox.filter((m) => m.recipientType !== "teacher")).toEqual([]);
  });

  test("a co-taught MAKE-UP: both of its coaches are told; an unlinked one is a SKIPPED row", async () => {
    const w = leaveWorld({ teachers: [{ id: "t1", lineUserId: "U-coach-t1" }, { id: "t9", lineUserId: null }], coTeachers: { m1: ["t9"] } });
    const h = run(w);
    await undoBooking("b1", { actor: "a", reason: null });
    expect(h.w.outbox.filter((m) => m.bookingId === "m1")).toEqual([makeupOff("m1", "U-coach-t1"), makeupOff("m1", null)]);
  });

  test("📌 a PENDING make-up was never announced — its cancel tells nobody (the cancel notice's own rule: only a class the coach HELD)", async () => {
    const w = leaveWorld();
    row(w, "m1").status = "PENDING";
    const h = run(w);
    await undoBooking("b1", { actor: "a", reason: null });
    expect(h.w.outbox.map((m) => m.payload.kind)).toEqual(["class_on_again_teacher"]);
    expect(h.coachesAsked).toEqual(["b1"]);
  });

  test("the words a DIFFERENT coach reads for the cancelled make-up — the existing cancel notice, unchanged; Reason = the note written on the row", () => {
    const CTX = { studentName: "มะขิด", subject: "Freeskate", date: "2026-11-06", startTime: "10:00", endTime: "11:00", coach: "Nok" };
    expect(formatOutboxMessage(makeupOff("m1", "U").payload as any, CTX as any, "TH", "teacher").split("\n")).toEqual([
      "CLASS CANCELLED / ยกเลิกคาบ ‼️",
      "Student : มะขิด",
      "Program : Freeskate 4 HR",
      "Date : 06-11-2026",
      "Time : 10:00-11:00",
      "Coach : Nok",
      "Reason : ยกเลิกคาบขยาย — ย้อนกลับการลา",
    ]);
  });

  // The two notices themselves, over a small fake transaction: WHO receives them.
  const fakeTx = (outbox: any[]) => ({
    query: {
      students: { findFirst: async () => ({ id: "s1", name: "Feen Full", nickname: "Feen" }) },
      appSettings: { findFirst: async () => ({ value: ["U-admin"] }) },
    },
    insert: (_t: any) => ({ values: async (v: any) => { outbox.push(v); } }),
  });
  const coTaughtCoaches = () => spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async (_e: any, id: string) =>
    id === "b1" ? [{ id: "t1", lineUserId: "U-coach-t1" }, { id: "t2", lineUserId: "U-coach-t2" }] : []) as any));

  test("🔑 a LEAVE notice on a co-taught class ⇒ BOTH coaches (and the admin, as before) — no parent", async () => {
    coTaughtCoaches();
    const outbox: any[] = [];
    await sched.sendLeaveNotice(fakeTx(outbox), { id: "b1", studentId: "s1", teacherId: "t1", bookingType: "COURSE_PACKAGE" }, { size: 4, via: "staff" });
    expect(outbox.map((m) => [m.recipientType, m.recipientLineUserId, m.payload.kind])).toEqual([
      ["admin", "U-admin", "leave_notice"],
      ["teacher", "U-coach-t1", "leave_notice"],
      ["teacher", "U-coach-t2", "leave_notice"],
    ]);
  });

  test("🔑 a CANCEL notice on a co-taught class ⇒ BOTH coaches, the PRIMARY's result reported (as the response always has) — no parent", async () => {
    coTaughtCoaches();
    const outbox: any[] = [];
    const res = await sched.sendClassCancelledToCoaches(fakeTx(outbox), { id: "b1", teacherId: "t1", bookingType: "COURSE_PACKAGE", course: { size: 4 } }, { cancelReason: "CUSTOMER_CANCELLED", note: null });
    expect(outbox.map((m) => [m.recipientType, m.recipientLineUserId, m.payload.kind])).toEqual([
      ["teacher", "U-coach-t1", "class_cancelled_teacher"],
      ["teacher", "U-coach-t2", "class_cancelled_teacher"],
    ]);
    expect(res).toEqual({ channel: "line", status: "queued" });
  });

  test("📌 by source: the leave, the cancel and the teacher's-own-leave senders all ask `teachersOfBooking` — none reads `teacherId` for a recipient; no parent recipient in them", () => {
    const S = src("src/services/scheduler.service.ts");
    const LEAVE = S.slice(S.indexOf("export async function sendLeaveNotice("), S.indexOf("const confirmedOnly ="));
    const CANCEL = S.slice(S.indexOf("async function sendClassCancelledToTeacher("), S.indexOf("export async function sendClassCancelledToFamilies("));
    const OTHERS = S.slice(S.indexOf("async function sendClassCancelledToOtherTeachers("), S.indexOf("export async function reportOwnLeave("));
    for (const R of [LEAVE, CANCEL, OTHERS]) {
      expect(R).toContain("await teachersOfBooking(tx, ");
      expect(R).not.toMatch(/tx\.query\.teachers\.find(First|Many)/);
      expect(R).not.toContain('recipientType: "parent"');
    }
  });
});
