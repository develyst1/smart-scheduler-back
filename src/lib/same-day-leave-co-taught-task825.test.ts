// TASK-825 (REQ-125 ruling B, DESIGN §2 row 1 + §4) — a SAME-DAY leave (the teacher's own door, or an admin on their behalf) no longer cancels a CO-TAUGHT class when a teacher remains:
//   · co-taught with a teacher remaining → `takeTeacherOffClass` (TASK-824): the leaver comes OFF it; it is NOT cancelled, the families are NOT told, no make-up;
//   · D4 «cannot» (nobody can take the main seat) → left AS IT IS, listed in `toHandle` (no cancel, no family notice);
//   · the sole / LAST teacher → exactly today's path (cancel + make-up + families + coaches), the answer byte-identical to before;
//   · D5 → `remainingCoaches` collects, per coach, the classes that run on with them (ONE LINE per coach per day — the message is TASK-827).
// By value through the real `reportTeacherLeave` / `reportOwnLeave` with a fake transaction.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { bookings, bookingTeachers } from "../db/schema";
import * as sched from "../services/scheduler.service";
import * as lineLib from "./line";
import * as adminLib from "./line-admin";
import { db } from "../db";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const SVC = readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => { const a = s.indexOf(from); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf(to, a + from.length)); };
const dialect = new PgDialect();
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

const TODAY = "2026-10-21";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", BEA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", CAL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const teacher = (id: string, nickname: string, extra: object = {}) => ({ id, name: nickname, nickname, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME", lineUserId: "U-" + nickname, ...extra });
type Cls = { id: string; startTime: string; teacherId: string; teacherRateMinor: number | null; bookingType: string; status: string; extras: Array<{ teacherId: string; rateMinor: number | null }> };
type World = { classes: Cls[]; teachers: Record<string, any>; leave: Array<{ teacherId: string; date: string }>; busy: Set<string>; cancelled: string[]; seatMoves: string[]; deletes: string[] };
const cls = (id: string, startTime: string, teacherId: string, extras: Array<[string, number | null]>, bookingType = "OTHER", status = "CONFIRMED"): Cls => ({ id, startTime, teacherId, teacherRateMinor: 50000, bookingType, status, extras: extras.map(([t, r]) => ({ teacherId: t, rateMinor: r })) });
const world = (classes: Cls[], over: Partial<World> = {}): World => ({
  classes, teachers: { [ME]: teacher(ME, "Mod"), [ANN]: teacher(ANN, "Ann"), [BEA]: teacher(BEA, "Bea"), [CAL]: teacher(CAL, "Cal") }, leave: [], busy: new Set(), cancelled: [], seatMoves: [], deletes: [], ...over,
});
const whereOf = (q: any): Record<string, unknown> => {
  const pairs = [q?.where?.(new Proxy({}, { get: (_t, k) => String(k) }), { and: (...a: any[]) => a.flat(), eq: (c: string, v: unknown) => [[c, v]] })].flat(3);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < pairs.length; i += 2) out[pairs[i] as string] = pairs[i + 1];
  return out;
};
const pgErr = (code: string) => Object.assign(new Error("pg"), { code });

function fakeTx(w: World) {
  const byId = (id: string) => w.classes.find((c) => c.id === id)!;
  const row = (c: Cls) => ({ id: c.id, date: TODAY, startTime: c.startTime, teacherId: c.teacherId, teacherRateMinor: c.teacherRateMinor, bookingType: c.bookingType, status: c.status });
  const tx: any = {
    query: {
      bookings: { findFirst: async (q: any) => {
        const id = Object.values(whereOf(q))[0] as string;
        const c = byId(id);
        if (q?.with?.teacher) return { ...row(c), teacher: w.teachers[c.teacherId], additionalTeachers: c.extras.map((e) => ({ teacherId: e.teacherId, teacher: w.teachers[e.teacherId] })) };
        if (q?.with?.additionalTeachers) return { ...row(c), additionalTeachers: c.extras.map((e) => ({ teacherId: e.teacherId, rateMinor: e.rateMinor, teacher: w.teachers[e.teacherId] })) };
        if (q?.columns?.bookingType) return { bookingType: c.bookingType, groupId: null };
        if (q?.columns?.id) return { id: c.id, date: TODAY, status: c.status };
        return row(c);
      } },
      teachers: { findFirst: async (q: any) => w.teachers[Object.values(whereOf(q))[0] as string] },
      teacherLeaveDays: { findFirst: async (q: any) => { const x = whereOf(q); return w.leave.find((l) => l.teacherId === x.teacherId && l.date === x.date); } },
      boMovement: { findMany: async () => [] },
      boItem: { findFirst: async () => undefined },
    },
    update: (table: any) => ({ set: (v: any) => ({ where: async (cond: unknown) => {
      expect(table).toBe(bookings);
      const params = dialect.sqlToQuery(cond as any).params as string[];
      const c = byId(params[0]!);
      if ("status" in v) { w.cancelled.push(c.id); c.status = v.status; return; } // the CANCEL path
      if ("teacherRateMinor" in v) { if (w.busy.has(v.teacherId)) throw pgErr("23505"); c.teacherId = v.teacherId; c.teacherRateMinor = v.teacherRateMinor; return; } // a main promotion
      w.seatMoves.push(v.teacherId); // a group's seats follow
    } }) }),
    delete: (table: any) => ({ where: async (cond: unknown) => {
      expect(table).toBe(bookingTeachers);
      const [bookingId, teacherId] = dialect.sqlToQuery(cond as any).params as string[];
      const c = byId(bookingId!);
      c.extras = c.extras.filter((e) => e.teacherId !== teacherId);
      w.deletes.push(`${bookingId}:${teacherId}`);
    } }),
    transaction: async (cb: any) => { const snap = JSON.stringify(w.classes); try { return await cb(tx); } catch (e) { w.classes = JSON.parse(snap); throw e; } },
  };
  return tx;
}
/** The act's own read of «my classes today»: every class I teach as the main or an extra (the database's `ownScopeWhere`). */
const arm = (w: World) => {
  setSystemTime(new Date(`${TODAY}T10:00:00+07:00`));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => w.classes
    .filter((c) => c.teacherId === ME || c.extras.some((e) => e.teacherId === ME))
    .map((c) => ({ id: c.id, date: TODAY, startTime: `${c.startTime}:00`, status: c.status, bookingType: c.bookingType, courseId: null, teacherId: c.teacherId, additionalTeachers: c.extras.map((e) => ({ teacherId: e.teacherId })), seats: [], course: null, voucher: null }))) as any));
  spies.push(spyOn(db, "transaction").mockImplementation((async (cb: any) => cb(fakeTx(w))) as any));
  // the ONE family sender: every class it is asked about is recorded, and each answers «1 household told» — so `familiesNotified` is exactly the number of classes it was asked about
  famCalls.length = 0;
  outbox.length = 0;
  adminAlerts.length = 0;
  // 🔻 TASK-829 — THE admin helper, recorded (the real one would read the admin accounts): payload + the exec it was handed + the booking it hangs off
  adminIds = ["U-admin-1"];
  adminRows.length = 0;
  spies.push(spyOn(adminLib, "getAdminLineUserIds").mockImplementation((async () => [...adminIds]) as any));
  // …and the real rule's rows (one per admin; no admin ⇒ ONE SKIPPED row, TASK-152), kept apart from `outbox` (the coach/family rows)
  spies.push(spyOn(adminLib, "notifyAdmins").mockImplementation((async (payload: any, exec: any, bookingId?: string) => {
    adminAlerts.push({ payload, exec, bookingId });
    if (!adminIds.length) adminRows.push({ recipientLineUserId: null, skipReason: "no admin recipient configured" });
    for (const id of adminIds) adminRows.push({ recipientLineUserId: id });
  }) as any));
  // 🔻 TASK-827 — every LINE the act enqueues is captured here (the coach notices are written in the act's own transaction)
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { outbox.push(o); return { status: "queued" } as any; }) as any));
  spies.push(spyOn(sched, "sendClassCancelledToFamilies").mockImplementation((async (_tx: any, current: any) => { famCalls.push(current.id); return 1; }) as any));
};
const famCalls: string[] = [];
const outbox: any[] = [];
let adminIds: string[] = ["U-admin-1"];
const adminRows: any[] = [];
const adminAlerts: Array<{ payload: any; exec: any; bookingId?: string }> = [];
const leave = (w: World, opts: { onBehalf?: boolean; sessionIds?: string[] } = {}) => sched.reportTeacherLeave(ME, { date: TODAY, reason: "ป่วย", ...(opts.sessionIds ? { sessionIds: opts.sessionIds } : {}) }, "actor", { onBehalf: opts.onBehalf ?? false });

describe("🔴 a co-taught class with a teacher remaining CONTINUES — not cancelled, no family told", () => {
  test("I am the MAIN of a 3-teacher ECA: Ann (first by name) becomes main on her own rate, I am off the class; NOT cancelled; the answer says it continues, with whom", async () => {
    const w = world([cls("eca", "10:00", ME, [[BEA, 62000], [ANN, 61000]])]);
    arm(w);
    const r: any = await leave(w);
    expect(w.cancelled).toEqual([]);
    expect(w.classes[0]).toMatchObject({ teacherId: ANN, teacherRateMinor: 61000, status: "CONFIRMED" });
    expect(w.classes[0]!.extras.map((e) => e.teacherId)).toEqual([BEA]);
    expect(r).toMatchObject({ cancelled: 0, bookingIds: [], familiesNotified: 0, toHandle: [] });
    expect(famCalls).toEqual([]); // 🔴 the ONE family sender was never even asked about this class
    // 🔻 TASK-827 — the REMAINING coaches are told, ONE message each, and nobody else: not the leaver, no family
    const coach = outbox.filter((m) => m.payload.kind === "teacher_coleave_continues");
    expect(coach.map((m) => m.recipientLineUserId).sort()).toEqual(["U-Ann", "U-Bea"]);
    expect(coach.every((m) => m.recipientType === "teacher")).toBe(true);
    expect(outbox.filter((m) => m.recipientType !== "teacher")).toEqual([]); // 🔴 FAMILIES: 0 messages for a class that continues
    expect(outbox.some((m) => m.recipientLineUserId === "U-Mod")).toBe(false); // 🔴 never the leaver
    const ann = coach.find((m) => m.recipientLineUserId === "U-Ann")!, bea = coach.find((m) => m.recipientLineUserId === "U-Bea")!;
    expect(ann.payload).toEqual({ kind: "teacher_coleave_continues", leaver: "Mod", date: TODAY, classes: [{ startTime: "10:00", title: null, becameMain: true }] }); // the promoted coach
    expect(bea.payload.classes).toEqual([{ startTime: "10:00", title: null, becameMain: false }]); // 🔴 the suffix only where promoted
    expect(r.continues).toEqual([{ bookingId: "eca", startTime: "10:00", with: ["Ann", "Bea"], promotedTo: ANN }]);
  });
  test("I am an EXTRA of the class: only my row goes; the main is unchanged; it continues (nobody promoted)", async () => {
    const w = world([cls("eca", "10:00", ANN, [[ME, 40000], [BEA, 62000]])]);
    arm(w);
    const r: any = await leave(w);
    expect(w.cancelled).toEqual([]);
    expect(w.classes[0]!.extras.map((e) => e.teacherId)).toEqual([BEA]);
    expect(w.classes[0]!.teacherId).toBe(ANN);
    expect(r.continues).toEqual([{ bookingId: "eca", startTime: "10:00", with: ["Ann", "Bea"], promotedTo: null }]);
    expect(r.cancelled).toBe(0);
  });
  test("a co-taught GROUP row: the main coach leaves ⇒ the swap's internals run: Ann is main, the seats follow, NOTHING cancelled (no cancelSeatsOfGroup)", async () => {
    const w = world([cls("grp", "14:00", ME, [[ANN, 61000]], "GROUP")]);
    arm(w);
    const r: any = await leave(w);
    expect(w.cancelled).toEqual([]);
    expect(w.seatMoves).toEqual([ANN]);
    expect(w.classes[0]).toMatchObject({ teacherId: ANN, teacherRateMinor: 61000 });
    expect(r.continues[0]).toMatchObject({ bookingId: "grp", promotedTo: ANN });
  });
  test("the admin door (onBehalf) and the teacher's own door do the SAME thing — `onBehalf` only decides who is told, never what happens", async () => {
    for (const onBehalf of [false, true]) {
      const w = world([cls("eca", "10:00", ME, [[ANN, 61000]])]);
      arm(w);
      const r: any = await leave(w, { onBehalf });
      expect([w.cancelled, r.continues.length, r.cancelled]).toEqual([[], 1, 0]);
      spies.splice(0).forEach((s) => s.mockRestore());
    }
  });
});

describe("🔴 D4 and «the last teacher»", () => {
  test("D4: no extra can take the main seat (every slot taken) ⇒ the class is left EXACTLY as it is, listed in `toHandle` — not cancelled, not in `continues`", async () => {
    const w = world([cls("eca", "10:00", ME, [[ANN, 61000], [BEA, 62000]])], { busy: new Set([ANN, BEA]) });
    arm(w);
    const r: any = await leave(w);
    expect(w.cancelled).toEqual([]);
    expect(w.classes[0]).toMatchObject({ teacherId: ME, teacherRateMinor: 50000 });
    expect(w.classes[0]!.extras.map((e) => e.teacherId)).toEqual([ANN, BEA]);
    expect(r.cancelled).toBe(0);
    expect(r.continues).toEqual([]);
    expect(r.toHandle).toEqual([{ bookingId: "eca", startTime: "10:00", reason: "no-eligible-main", message: expect.any(String) }]);
  });
  test("🔴 I am the LAST teacher (every other teacher is on leave today) ⇒ today's path: the class IS cancelled; it is in neither `continues` nor `toHandle`", async () => {
    const w = world([cls("eca", "10:00", ME, [[ANN, 61000], [BEA, 62000]], "OTHER", "PENDING")], { leave: [{ teacherId: ANN, date: TODAY }, { teacherId: BEA, date: TODAY }] });
    arm(w);
    const r: any = await leave(w);
    expect(w.cancelled).toEqual(["eca"]);
    expect(r).toMatchObject({ cancelled: 1, bookingIds: ["eca"] });
    expect(r.continues ?? []).toEqual([]);
    expect(r.toHandle ?? []).toEqual([]);
  });
  test("a SOLE-teacher class (no extras — a private, a course, a trial…) ⇒ exactly today's cancel, and the answer is BYTE-IDENTICAL to before (no new keys)", async () => {
    const w = world([cls("p1", "09:00", ME, [], "PRIVATE", "PENDING")]);
    arm(w);
    const r = await leave(w);
    expect(w.cancelled).toEqual(["p1"]);
    expect(r).toEqual({ cancelled: 1, bookingIds: ["p1"], familiesNotified: 1 }); // (the sender is stubbed to «1 household» per class it is asked about)
    expect(famCalls).toEqual(["p1"]);
  });
  test("a sole-teacher DAY with several classes: `cancelled` = every live target, in order, byte-identical keys; the families are asked about each", async () => {
    const w = world([cls("p1", "09:00", ME, [], "PRIVATE", "PENDING"), cls("p2", "10:00", ME, [], "COURSE_PACKAGE", "PENDING"), cls("p3", "11:00", ME, [], "PRIVATE", "PENDING")]);
    arm(w);
    const r = await leave(w);
    expect(r).toEqual({ cancelled: 3, bookingIds: ["p1", "p2", "p3"], familiesNotified: 3 });
    expect(famCalls).toEqual(["p1", "p2", "p3"]);
  });
});

describe("🔴 a mixed day, the coach notices (D5), and sessionIds", () => {
  test("one co-taught class continues AND one sole class is cancelled: cancelled 1, continues 1; the cancelled list names only the sole one", async () => {
    const w = world([cls("eca", "10:00", ME, [[ANN, 61000]]), cls("p1", "11:00", ME, [], "PRIVATE", "PENDING")]);
    arm(w);
    const r: any = await leave(w);
    expect(w.cancelled).toEqual(["p1"]);
    expect(r).toMatchObject({ cancelled: 1, bookingIds: ["p1"], familiesNotified: 1 }); // 🔴 `cancelled` counts ONLY the cancelled class; `familiesNotified` only ITS household
    expect(famCalls).toEqual(["p1"]); // 🔴 the continuing class's family was never told
    expect(r.continues.map((c: any) => c.bookingId)).toEqual(["eca"]);
  });
  test("D5: ONE entry per remaining coach carrying ALL their classes of the day (one LINE per coach per day); `becameMain` marks the promotion", async () => {
    const w = world([cls("a", "10:00", ME, [[ANN, 61000], [BEA, 62000]]), cls("b", "13:00", ANN, [[ME, 40000], [BEA, 62000]])]);
    arm(w);
    const r: any = await leave(w);
    const byCoach = Object.fromEntries(r.remainingCoaches.map((n: any) => [n.teacherId, n.classes]));
    expect(r.remainingCoaches.map((n: any) => n.teacherId).sort()).toEqual([ANN, BEA].sort());
    expect(byCoach[ANN]).toEqual([{ bookingId: "a", startTime: "10:00", becameMain: true }, { bookingId: "b", startTime: "13:00", becameMain: false }]);
    expect(byCoach[BEA]).toEqual([{ bookingId: "a", startTime: "10:00", becameMain: false }, { bookingId: "b", startTime: "13:00", becameMain: false }]);
    expect(r.remainingCoaches.some((n: any) => n.teacherId === ME)).toBe(false); // never me
    // 🔴 ONE message per coach per DAY listing BOTH classes (not one per class), and the suffix only on the class where Ann was promoted
    const coach = outbox.filter((m) => m.payload.kind === "teacher_coleave_continues");
    expect(coach).toHaveLength(2);
    const ann = coach.find((m) => m.recipientLineUserId === "U-Ann")!;
    expect(ann.payload.classes).toEqual([{ startTime: "10:00", title: null, becameMain: true }, { startTime: "13:00", title: null, becameMain: false }]);
    expect(coach.find((m) => m.recipientLineUserId === "U-Bea")!.payload.classes).toHaveLength(2);
  });
  test("a coach who is ON LEAVE today is not in the notices (nobody to tell)", async () => {
    const w = world([cls("a", "10:00", ME, [[ANN, 61000], [BEA, 62000]])], { leave: [{ teacherId: BEA, date: TODAY }] });
    arm(w);
    const r: any = await leave(w);
    expect(r.remainingCoaches.map((n: any) => n.teacherId)).toEqual([ANN]);
    expect(outbox.filter((m) => m.payload.kind === "teacher_coleave_continues").map((m) => m.recipientLineUserId)).toEqual(["U-Ann"]); // 🔻 TASK-827: nobody to tell on Bea's leave day
    expect(w.classes[0]!.teacherId).toBe(ANN); // Bea is skipped as the next main
  });
  test("`sessionIds`: only the chosen class is touched; the other co-taught class keeps me", async () => {
    const w = world([cls("a", "10:00", ME, [[ANN, 61000]]), cls("b", "12:00", ME, [[BEA, 62000]])]);
    arm(w);
    const r: any = await leave(w, { sessionIds: ["b"] });
    expect(r.continues.map((c: any) => c.bookingId)).toEqual(["b"]);
    expect(w.classes.find((c) => c.id === "a")!.teacherId).toBe(ME);
  });
});

describe("🔴 TASK-829 (K1 b) — ONE alert to the ADMINS for the classes left AS THEY ARE (D4), from the same-day act only; ⏳ the sentence is a «copy pending» draft", () => {
  test("a day with 1 D4 class + 1 continuing + 1 sole ⇒ exactly ONE admin alert, listing ONLY the D4 class; nothing to a coach about it, nothing to a family", async () => {
    const w = world([cls("d4", "10:00", ME, [[CAL, 70000]]), cls("go", "12:00", ME, [[ANN, 61000]]), cls("p1", "14:00", ME, [], "PRIVATE", "PENDING")], { busy: new Set([CAL]) });
    arm(w);
    const r: any = await leave(w);
    expect(r.toHandle.map((c: any) => c.bookingId)).toEqual(["d4"]);
    expect(r.continues.map((c: any) => c.bookingId)).toEqual(["go"]);
    expect(w.cancelled).toEqual(["p1"]);
    expect(adminAlerts).toHaveLength(1);
    expect(adminAlerts[0]!.payload).toEqual({ kind: "teacher_leave_left_as_is_admin", leaver: "Mod", date: TODAY, classes: [{ startTime: "10:00", title: null }] });
    expect(adminAlerts[0]!.bookingId).toBe("d4");
    expect(adminAlerts[0]!.exec).toBeDefined(); // handed the act's TRANSACTION, not the default connection
    expect(outbox.some((m) => m.payload.kind === "teacher_leave_left_as_is_admin")).toBe(false); // not through any coach / family path
    expect(outbox.filter((m) => m.recipientType !== "teacher")).toEqual([]);
  });
  test("TWO D4 classes ⇒ still ONE alert (one per ACT), listing both in time order", async () => {
    const w = world([cls("a", "10:00", ME, [[CAL, 70000]]), cls("b", "13:00", ME, [[CAL, 70000]])], { busy: new Set([CAL]) });
    arm(w);
    await leave(w);
    expect(adminAlerts).toHaveLength(1);
    expect(adminAlerts[0]!.payload.classes.map((c: any) => c.startTime)).toEqual(["10:00", "13:00"]);
  });
  test("NO D4 class ⇒ NO alert (a continuing class, a sole class, a last-teacher cancel — none of them is “left as is”)", async () => {
    for (const w of [world([cls("go", "12:00", ME, [[ANN, 61000]])]), world([cls("p1", "14:00", ME, [], "PRIVATE", "PENDING")]), world([cls("last", "10:00", ME, [[ANN, 61000]], "OTHER", "PENDING")], { leave: [{ teacherId: ANN, date: TODAY }] })]) {
      arm(w);
      await leave(w);
      expect(adminAlerts).toEqual([]);
      spies.splice(0).forEach((x) => x.mockRestore());
    }
  });
  test("🔻 addendum — `adminsAlerted` = how many admins the alert was queued for, only when a class was left as is: 2 admins → 2; NO admin → 0 and the one SKIPPED row; no D4 (continuing / sole / mixed with none left) → the key is absent", async () => {
    const d4 = () => world([cls("d4", "10:00", ME, [[CAL, 70000]])], { busy: new Set([CAL]) });
    arm(d4());
    adminIds = ["U-1", "U-2"];
    const two: any = await leave(d4());
    expect(two.adminsAlerted).toBe(2);
    expect(adminRows.map((r) => r.recipientLineUserId)).toEqual(["U-1", "U-2"]);
    spies.splice(0).forEach((x) => x.mockRestore());
    arm(d4());
    adminIds = [];
    const none: any = await leave(d4());
    expect(none.adminsAlerted).toBe(0); // the answer says 0 although a row WAS written…
    expect(adminRows).toEqual([{ recipientLineUserId: null, skipReason: "no admin recipient configured" }]); // …the SKIPPED one
    spies.splice(0).forEach((x) => x.mockRestore());
    for (const w of [world([cls("go", "12:00", ME, [[ANN, 61000]])]), world([cls("p1", "14:00", ME, [], "PRIVATE", "PENDING")])]) {
      arm(w);
      const r: any = await leave(w);
      expect(Object.keys(r)).not.toContain("adminsAlerted");
      spies.splice(0).forEach((x) => x.mockRestore());
    }
  });
  test("the admin and the teacher's own door alike (onBehalf only decides who is told about the LEAVE, not this alert)", async () => {
    for (const onBehalf of [false, true]) {
      const w = world([cls("d4", "10:00", ME, [[CAL, 70000]])], { busy: new Set([CAL]) });
      arm(w);
      await leave(w, { onBehalf });
      expect(adminAlerts).toHaveLength(1);
      spies.splice(0).forEach((x) => x.mockRestore());
    }
  });
});

describe("🔑 by source — the split lives in the act, before the cancel; the families are never reached from the continue branch", () => {
  const ACT = code(region(SVC, "export async function reportTeacherLeave(", "export type SameDayContinuedClass"));
  const BRANCH = ACT.slice(ACT.indexOf("if (((b as any).additionalTeachers ?? []).length > 0) {"), ACT.indexOf("const coachOff: CoachOff[]"));
  test("exactly ONE call of the block in the act, before any cancel write; the branch cancels, notifies and re-plans nothing", () => {
    expect([...ACT.matchAll(/takeTeacherOffClass\(/g)]).toHaveLength(1);
    expect(ACT.indexOf("takeTeacherOffClass(")).toBeLessThan(ACT.indexOf('set({ status: "CANCELLED"'));
    expect(BRANCH).not.toMatch(/CANCELLED|sendClassCancelled|enqueueLine|reconcileCoursePlan|addLeaveWeek|cancelSeatsOfGroup/);
    expect(BRANCH).toContain('if (out.reason === "no-eligible-main") {');
    expect([...BRANCH.matchAll(/continue;/g)]).toHaveLength(2); // «continues» and D4 only — «no teacher remains» (I am the LAST teacher) falls through to today's cancel path
  });
  test("the cancel path itself is untouched and now records what it cancelled; the sole-teacher answer keeps its keys", () => {
    expect(ACT).toContain('set({ status: "CANCELLED", note: input.reason, cancelReason: "TEACHER_LEAVE" })');
    expect(ACT).toContain("cancelledIds.push(b.id);");
    expect(ACT).toContain("const split = continues.length || toHandle.length ? { continues, toHandle, remainingCoaches: [...coachNotices.values()], ...(toHandle.length ? { adminsAlerted } : {}) } : {};");
    expect(ACT).toContain("return { cancelled: cancelledIds.length, bookingIds: cancelledIds, familiesNotified, ...split };");
  });
});
