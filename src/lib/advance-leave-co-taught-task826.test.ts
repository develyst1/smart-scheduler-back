// TASK-826 (REQ-125 ruling B, DESIGN §2 rows 2–3 + §3) — an ADVANCE leave (one day or a range) on ruling B, REMEMBERED so Cancel leave restores:
//   · record → every co-taught class of the day with a teacher remaining: the leaver comes OFF it (`takeTeacherOffClass`, 824) and a `teacher_leave_removals` row remembers it (leave day · class · was main · my old rate · date);
//     D4 «cannot» → left as it is, listed; the sole / LAST teacher → untouched, still in the plain «to handle» list;
//   · Cancel leave (per day and per range) → the teacher is put BACK as an EXTRA teacher (D2) at the old rate on every class still live that they are not already on; the rows are cleared;
//   · the list shows what each day took the teacher off; the answers carry the new keys ONLY when a co-taught class was involved (a sole-teacher answer is byte-identical);
//   · the PREVIEW is the act run inside a transaction that is ROLLED BACK (preview = act, nothing written); the teacher's own door takes `?preview=DATE`.
// By value through the real service functions with one in-memory executor behind `db`.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as sched from "../services/scheduler.service";
import * as lineLib from "./line";
import * as adminLib from "./line-admin";
import * as v from "../validation";
import { TEACHER_ALLOWED } from "./route-access";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { DEV_USER } from "../middleware/auth";
import { db } from "../db";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => { const a = s.indexOf(from); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf(to, a + from.length)); };
const dialect = new PgDialect();
const spies: Array<{ mockRestore: () => void }> = [];
const savedUser = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, savedUser); });

const TODAY = "2026-10-21", D1 = "2026-10-23", D2 = "2026-10-24", D3 = "2026-10-25";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ANN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", BEA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const teacher = (id: string, nickname: string, extra: object = {}) => ({ id, name: nickname, nickname, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME", lineUserId: "U-" + nickname, ...extra });
type Cls = { id: string; date: string; startTime: string; teacherId: string; teacherRateMinor: number | null; bookingType: string; status: string; extras: Array<{ teacherId: string; rateMinor: number | null }> };
type LeaveRow = { id: string; teacherId: string; date: string; reason: string | null; createdBy: string | null; rangeId?: string | null };
type Removal = { id: string; leaveDayId: string; bookingId: string; teacherId: string; date: string; wasMain: boolean; rateMinor: number | null };
type World = { classes: Cls[]; leave: LeaveRow[]; removals: Removal[]; teachers: Record<string, any>; busy: Set<string>; seatMoves: string[]; sent: any[]; txOpened: number; failOnDate?: string };
const cls = (id: string, date: string, startTime: string, teacherId: string, extras: Array<[string, number | null]>, bookingType = "OTHER", status = "CONFIRMED"): Cls => ({ id, date, startTime, teacherId, teacherRateMinor: 50000, bookingType, status, extras: extras.map(([t, r]) => ({ teacherId: t, rateMinor: r })) });
const world = (classes: Cls[], over: Partial<World> = {}): World => ({
  classes, leave: [], removals: [], teachers: { [ME]: teacher(ME, "Mod"), [ANN]: teacher(ANN, "Ann"), [BEA]: teacher(BEA, "Bea") }, busy: new Set(), seatMoves: [], sent: [], txOpened: 0, ...over,
});
const whereOf = (q: any): Record<string, unknown> => {
  const pairs = [q?.where?.(new Proxy({}, { get: (_t, k) => String(k) }), { and: (...a: any[]) => a.flat(), eq: (c: string, val: unknown) => [[c, val]] })].flat(3);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < pairs.length; i += 2) out[pairs[i] as string] = pairs[i + 1];
  return out;
};
const sqlOf = (cond: unknown) => dialect.sqlToQuery(cond as any);
const pgErr = (c: string) => Object.assign(new Error("pg"), { code: c });
let seq = 0;

/** ONE in-memory executor behind `db` AND behind every transaction (a transaction snapshots the mutable state and restores it if the callback throws). */
function executor(w: World) {
  const byId = (id: string) => w.classes.find((c) => c.id === id)!;
  const live = (c: Cls) => ["PENDING", "CONFIRMED", "EXTENDED"].includes(c.status);
  const bookingRow = (c: Cls) => ({ id: c.id, otherTitle: c.id, date: c.date, startTime: c.startTime, teacherId: c.teacherId, teacherRateMinor: c.teacherRateMinor, bookingType: c.bookingType, status: c.status });
  const dayRows = (date: string, me: string) => w.classes.filter((c) => c.date === date && live(c) && (c.teacherId === me || c.extras.some((e) => e.teacherId === me))).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const select = (fields: any) => {
    if (fields && "one" in fields) { const q: any = { from: () => q, where: () => q }; return q; } // the scope predicate's inner EXISTS
    return { from: (table: any) => {
      const name = getTableName(table);
      const chain: any = { innerJoin: () => chain };
      chain.where = (cond: unknown) => {
        const { sql: text, params } = sqlOf(cond);
        let rows: any[] = [];
        if (name === "bookings") { // leaveDayBookings: params[0] = the date, the LAST param = the teacher
          const me = [...params].reverse().find((x) => typeof x === "string" && w.teachers[x as string]) as string; // the teacher id (the scope predicate's EXISTS parameter is a stub here)
          rows = dayRows(params[0] as string, me).map((c) => ({ id: c.id, date: c.date, startTime: `${c.startTime}:00`, endTime: "11:00:00", status: c.status, bookingType: c.bookingType, childName: null, childNickname: null, coChildName: null, coChildNickname: null, program: null, title: c.id, inCourse: false }));
        } else if (name === "teacher_leave_removals") {
          rows = text.includes('"teacher_id"') && !text.includes(">=")
            ? w.removals.filter((r) => r.teacherId === params[0] && (params.slice(1) as string[]).includes(r.date))
            : w.removals.filter((r) => r.date >= (params[0] as string) && r.date <= (params[1] as string));
        } else if (name === "teacher_leave_days" && text.includes('"range_id"')) { // liftAdvanceLeaveRange's read: the rows of one record
          rows = w.leave.filter((l) => l.rangeId === params[0]).sort((a, b) => a.date.localeCompare(b.date)).map((l) => ({ teacherId: l.teacherId, date: l.date }));
        } else if (name === "teacher_leave_days") {
          rows = w.leave.filter((l) => l.date >= (params[0] as string) && l.date <= (params[1] as string) && (params.length < 3 || l.teacherId === params[2])).sort((a, b) => a.date.localeCompare(b.date))
            .map((l) => ({ teacherId: l.teacherId, teacherName: w.teachers[l.teacherId].nickname, date: l.date, reason: l.reason, createdBy: l.createdBy, rangeId: l.rangeId ?? null }));
        }
        const th: any = Promise.resolve(rows);
        th.orderBy = async () => rows;
        return th;
      };
      return chain;
    } };
  };
  const insert = (table: any) => {
    const name = getTableName(table);
    return { values: (val: any) => {
      const out: any = {};
      out.onConflictDoNothing = () => {
        const th: any = (async () => {
          if (name === "teacher_leave_days") { if (w.leave.some((l) => l.teacherId === val.teacherId && l.date === val.date)) return []; const row = { id: `lv-${++seq}`, ...val }; w.leave.push(row); return [row]; }
          if (name === "teacher_leave_removals") { if (!w.removals.some((r) => r.leaveDayId === val.leaveDayId && r.bookingId === val.bookingId)) w.removals.push({ id: `rm-${++seq}`, ...val }); return []; }
          if (name === "booking_teachers") { const c = byId(val.bookingId); if (!c.extras.some((e) => e.teacherId === val.teacherId)) c.extras.push({ teacherId: val.teacherId, rateMinor: val.rateMinor ?? null }); return []; }
          throw new Error("unexpected insert into " + name);
        })();
        th.returning = () => th;
        return th;
      };
      return out;
    } };
  };
  const del = (table: any) => {
    const name = getTableName(table);
    return { where: (cond: unknown) => {
      const { params } = sqlOf(cond);
      const run = async () => {
        if (name === "teacher_leave_days" && sqlOf(cond).sql.includes('"range_id"')) { const [rid, ...ds] = params as string[]; const gone = w.leave.filter((l) => l.rangeId === rid && ds.includes(l.date)); w.leave = w.leave.filter((l) => !gone.includes(l)); w.removals = w.removals.filter((r) => !gone.some((g) => g.id === r.leaveDayId)); return gone.map((g) => ({ id: g.id })); }
        if (name === "teacher_leave_days") { const gone = w.leave.filter((l) => l.teacherId === params[0] && l.date === params[1]); w.leave = w.leave.filter((l) => !gone.includes(l)); w.removals = w.removals.filter((r) => !gone.some((g) => g.id === r.leaveDayId)); return gone.map((g) => ({ id: g.id })); }
        if (name === "teacher_leave_removals") { w.removals = w.removals.filter((r) => !(params as string[]).includes(r.id)); return []; }
        if (name === "booking_teachers") { const [bookingId, teacherId] = params as string[]; const c = byId(bookingId!); c.extras = c.extras.filter((e) => e.teacherId !== teacherId); return []; }
        throw new Error("unexpected delete from " + name);
      };
      const th: any = run();
      th.returning = () => th;
      return th;
    } };
  };
  const update = (_table: any) => ({ set: (val: any) => ({ where: async (cond: unknown) => {
    const c = byId((sqlOf(cond).params as string[])[0]!);
    if ("status" in val) { c.status = val.status; return; }
    if ("teacherRateMinor" in val) { if (w.busy.has(val.teacherId)) throw pgErr("23505"); c.teacherId = val.teacherId; c.teacherRateMinor = val.teacherRateMinor; return; }
    w.seatMoves.push(val.teacherId);
  } }) });
  const query: any = {
    bookings: {
      findFirst: async (q: any) => {
        const id = Object.values(whereOf(q))[0] as string;
        const c = byId(id);
        if (!c) return undefined;
        if (q?.with?.teacher) return { ...bookingRow(c), teacher: w.teachers[c.teacherId], additionalTeachers: c.extras.map((e) => ({ teacherId: e.teacherId, teacher: w.teachers[e.teacherId] })) };
        if (q?.with?.additionalTeachers) return { ...bookingRow(c), additionalTeachers: c.extras.map((e) => ({ teacherId: e.teacherId, rateMinor: e.rateMinor, teacher: w.teachers[e.teacherId] })) };
        if (q?.columns?.bookingType) return { bookingType: c.bookingType, groupId: null };
        if (q?.columns?.id && !q?.columns?.status) return bookingRow(c);
        return bookingRow(c);
      },
      findMany: async (q: any) => { // the PREVIEW's read of «my live classes on that day»
        const date = (sqlOfWhereDate(q) as string);
        return dayRows(date, previewTeacher).map((c) => ({ ...bookingRow(c), additionalTeachers: c.extras.map((e) => ({ teacherId: e.teacherId })) }));
      },
    },
    teachers: { findFirst: async (q: any) => w.teachers[Object.values(whereOf(q))[0] as string] },
    teacherLeaveDays: { findFirst: async (q: any) => { const x = whereOf(q); return w.leave.find((l) => l.teacherId === x.teacherId && l.date === x.date); } },
    boMovement: { findMany: async () => [] },
    boItem: { findFirst: async () => undefined },
  };
  let previewTeacher = ME;
  const sqlOfWhereDate = (q: any) => {
    // the preview's where callback: evaluate with a proxy that records the first eq() value (the date)
    let first: unknown;
    q.where(new Proxy({}, { get: (_t: any, k: any) => String(k) }), { and: () => 0, eq: (_c: string, val: unknown) => { first ??= val; return 0; }, isNull: () => 0, inArray: () => 0 });
    return first;
  };
  const snap = () => JSON.stringify({ c: w.classes, l: w.leave, r: w.removals, s: w.seatMoves });
  const restore = (s: string) => { const o = JSON.parse(s); w.classes = o.c; w.leave = o.l; w.removals = o.r; w.seatMoves = o.s; };
  const ex: any = { select, insert, delete: del, update, query, setPreviewTeacher: (t: string) => { previewTeacher = t; } };
  ex.transaction = async (cb: any) => {
    w.txOpened++;
    const s = snap();
    try { return await cb(ex); } catch (e) { restore(s); throw e; }
  };
  return ex;
}
function install(w: World, today = TODAY, previewTeacher = ME) {
  setSystemTime(new Date(`${today}T10:00:00+07:00`));
  const ex = executor(w);
  ex.setPreviewTeacher(previewTeacher);
  spies.push(spyOn(db, "select").mockImplementation(ex.select as any));
  spies.push(spyOn(db, "insert").mockImplementation(ex.insert as any));
  spies.push(spyOn(db, "delete").mockImplementation(ex.delete as any));
  spies.push(spyOn(db, "update").mockImplementation(ex.update as any));
  spies.push(spyOn(db, "transaction").mockImplementation(ex.transaction as any));
  for (const t of ["bookings", "teachers", "teacherLeaveDays", "boMovement", "boItem"] as const) {
    for (const m of Object.keys(ex.query[t])) spies.push(spyOn((db.query as any)[t], m as any).mockImplementation(ex.query[t][m]));
  }
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { w.sent.push(o); return { status: "queued" } as any; }) as any));
  return ex;
}
const record = (w: World, date: string, onBehalf = true) => sched.reportTeacherLeave(ME, { date, reason: "อบรม" }, "admin", { onBehalf });
const recordRange = (w: World, from: string, to: string) => sched.reportTeacherLeave(ME, { date: from, to, reason: "อบรม" } as any, "admin", { onBehalf: true });
const eca = (id: string, date = D1, startTime = "10:00") => cls(id, date, startTime, ME, [[BEA, 62000], [ANN, 61000]]);

describe("🔴 RECORD — one future day: the leaver comes OFF co-taught classes that run on, and it is remembered", () => {
  test("main of a 3-teacher ECA: Ann (name order) is promoted on HER rate, I am off; ONE removal row remembers {leave day · class · was main · my old rate · date}; the answer says it continues, nothing is left to handle", async () => {
    const w = world([eca("eca")]);
    install(w);
    const r: any = await record(w, D1);
    expect(w.classes[0]).toMatchObject({ teacherId: ANN, teacherRateMinor: 61000 });
    expect(w.classes[0]!.extras.map((e) => e.teacherId)).toEqual([BEA]);
    expect(w.removals).toHaveLength(1);
    expect(w.removals[0]).toMatchObject({ leaveDayId: w.leave[0]!.id, bookingId: "eca", teacherId: ME, date: D1, wasMain: true, rateMinor: 50000 });
    expect(r).toMatchObject({ mode: "advance", cancelled: 0, bookingIds: [], familiesNotified: 0, alreadyRecorded: false, bookings: [], toHandle: [] });
    expect(r.continues).toEqual([{ bookingId: "eca", startTime: "10:00", with: ["Ann", "Bea"], promotedTo: ANN }]);
    expect(r.remainingCoaches.map((n: any) => n.teacherId).sort()).toEqual([ANN, BEA].sort());
    // the teacher's notice: nothing left of theirs «still on», and the co-taught count rides along for TASK-827's extra line
    const own = w.sent.filter((s) => s.payload.kind === "teacher_leave_recorded");
    expect(own).toHaveLength(1);
    expect(own[0].payload).toEqual({ kind: "teacher_leave_recorded", date: D1, classes: 0, continued: 1, actor: "admin" });
    // 🔻 TASK-827 — and each REMAINING coach gets ONE message in the same act (not the leaver, no family)
    const coach = w.sent.filter((s) => s.payload.kind === "teacher_coleave_continues");
    expect(coach.map((m) => m.recipientLineUserId).sort()).toEqual(["U-Ann", "U-Bea"]);
    expect(coach.find((m) => m.recipientLineUserId === "U-Ann")!.payload).toEqual({ kind: "teacher_coleave_continues", leaver: "Mod", date: D1, classes: [{ startTime: "10:00", title: "eca", becameMain: true }] });
    expect(coach.find((m) => m.recipientLineUserId === "U-Bea")!.payload.classes).toEqual([{ startTime: "10:00", title: "eca", becameMain: false }]); // the suffix only where promoted
    expect(w.sent.filter((s) => s.recipientType !== "teacher")).toEqual([]); // 🔴 families: 0
    expect(coach.some((m) => m.recipientLineUserId === "U-Mod")).toBe(false); // 🔴 the coach notices never go to the leaver (their own `teacher_leave_recorded` is the only message they get)
  });
  test("🔻 TASK-827 — TWO co-taught classes with the same remaining coach on one day ⇒ ONE message to that coach listing BOTH (one per coach per day)", async () => {
    const w = world([eca("a", D1, "10:00"), cls("b", D1, "13:00", ANN, [[ME, 40000], [BEA, 62000]])]);
    install(w);
    await record(w, D1);
    const coach = w.sent.filter((s) => s.payload.kind === "teacher_coleave_continues");
    expect(coach).toHaveLength(2); // Ann + Bea, once each
    expect(coach.find((m) => m.recipientLineUserId === "U-Ann")!.payload.classes).toEqual([{ startTime: "10:00", title: "a", becameMain: true }, { startTime: "13:00", title: "b", becameMain: false }]);
  });
  test("🔻 TASK-827 — a PREVIEW never enqueues the coach notices (it never calls the sender): 0 outbox rows of ANY kind", async () => {
    const w = world([eca("eca")]);
    install(w);
    await sched.previewTeacherLeave(ME, D1);
    expect(w.sent).toEqual([]);
  });
  test("I am an EXTRA: my row goes; the removal row says wasMain false and keeps MY stored rate", async () => {
    const w = world([cls("eca", D1, "10:00", ANN, [[ME, 40000], [BEA, 62000]])]);
    install(w);
    const r: any = await record(w, D1);
    expect(w.classes[0]!.teacherId).toBe(ANN);
    expect(w.classes[0]!.extras.map((e) => e.teacherId)).toEqual([BEA]);
    expect(w.removals[0]).toMatchObject({ wasMain: false, rateMinor: 40000 });
    expect(r.continues[0]).toMatchObject({ promotedTo: null });
  });
  test("a co-taught GROUP row: the seats follow the new main (the swap's internals); the removal row is written", async () => {
    const w = world([cls("grp", D1, "14:00", ME, [[ANN, 61000]], "GROUP")]);
    install(w);
    await record(w, D1);
    expect(w.classes[0]).toMatchObject({ teacherId: ANN, teacherRateMinor: 61000 });
    expect(w.seatMoves).toEqual([ANN]);
    expect(w.removals).toHaveLength(1);
  });
  test("D4: nobody can take the main seat ⇒ the class stays on me, in `toHandle` AND still in the plain list; NO removal row", async () => {
    const w = world([eca("eca")], { busy: new Set([ANN, BEA]) });
    install(w);
    const r: any = await record(w, D1);
    expect(w.classes[0]).toMatchObject({ teacherId: ME, teacherRateMinor: 50000 });
    expect(w.removals).toEqual([]);
    expect(r.toHandle).toEqual([{ bookingId: "eca", startTime: "10:00", reason: "no-eligible-main", message: expect.any(String) }]);
    expect(r.bookings.map((b: any) => b.id)).toEqual(["eca"]);
    expect(r.continues ?? []).toEqual([]);
  });
  test("the LAST teacher (every other teacher is on leave that day): untouched, still listed to handle; no removal row, no `continues`", async () => {
    const w = world([eca("eca")], { leave: [{ id: "lv-a", teacherId: ANN, date: D1, reason: null, createdBy: null }, { id: "lv-b", teacherId: BEA, date: D1, reason: null, createdBy: null }] });
    install(w);
    const r: any = await record(w, D1);
    expect(w.classes[0]).toMatchObject({ teacherId: ME });
    expect(w.removals).toEqual([]);
    expect(r.bookings.map((b: any) => b.id)).toEqual(["eca"]);
    expect(r.continues ?? []).toEqual([]);
  });
  test("a day of SOLE-teacher classes: the answer is byte-identical to before (no new keys) and NO transaction is opened", async () => {
    const w = world([cls("p1", D1, "09:00", ME, [], "PRIVATE"), cls("c1", D1, "10:00", ME, [], "COURSE_PACKAGE")]);
    install(w);
    const r: any = await record(w, D1);
    expect(Object.keys(r).sort()).toEqual(["alreadyRecorded", "bookingIds", "bookings", "cancelled", "familiesNotified", "leave", "mode", "teacherNotified"]);
    expect(r.bookings.map((b: any) => b.id)).toEqual(["p1", "c1"]);
    expect(w.txOpened).toBe(0);
    expect(w.sent[0].payload).toEqual({ kind: "teacher_leave_recorded", date: D1, classes: 2, actor: "admin" });
  });
  test("recording the SAME day again is idempotent: the class already off me is not touched, no second removal row, nobody is told twice", async () => {
    const w = world([eca("eca")]);
    install(w);
    await record(w, D1);
    const before = JSON.stringify({ c: w.classes, r: w.removals });
    const r2: any = await record(w, D1);
    expect(JSON.stringify({ c: w.classes, r: w.removals })).toBe(before);
    expect(r2).toMatchObject({ alreadyRecorded: true, teacherNotified: 0 });
    expect(w.sent.map((s) => s.payload.kind).sort()).toEqual(["teacher_coleave_continues", "teacher_coleave_continues", "teacher_leave_recorded"]); // 🔻 the second record sent NOTHING more: not the leaver, not the coaches
  });
});

describe("🔴 RECORD — a date RANGE: one transaction, the take-off per day, one LINE", () => {
  test("a 3-day range with a co-taught class on day 2 only: ONE removal row (day 2), per-day answers, `continuedClasses: 1`, ONE notice carrying `continued` and the span", async () => {
    const w = world([cls("p1", D1, "09:00", ME, [], "PRIVATE"), eca("eca", D2), cls("p3", D3, "09:00", ME, [], "PRIVATE")]);
    install(w);
    const r: any = await recordRange(w, D1, D3);
    expect(w.leave.map((l) => l.date)).toEqual([D1, D2, D3]);
    expect(new Set(w.leave.map((l) => l.rangeId)).size).toBe(1);
    expect(w.removals.map((x) => [x.date, x.bookingId])).toEqual([[D2, "eca"]]);
    expect(r.days.map((d: any) => [d.date, d.bookings.map((b: any) => b.id), d.continues?.length ?? 0])).toEqual([[D1, ["p1"], 0], [D2, [], 1], [D3, ["p3"], 0]]);
    expect(r.continuedClasses).toBe(1);
    expect(r.days.map((d: any) => ["continues" in d, "toHandle" in d, "remainingCoaches" in d])).toEqual([[false, false, false], [true, true, true], [false, false, false]]); // the new keys only on the day a co-taught class was involved
    const own = w.sent.filter((s) => s.payload.kind === "teacher_leave_recorded");
    expect(own).toHaveLength(1);
    expect(own[0].payload).toEqual({ kind: "teacher_leave_recorded", date: D1, to: D3, classes: 2, continued: 1, actor: "admin" });
    expect(w.sent.filter((s) => s.payload.kind === "teacher_coleave_continues").map((m) => [m.recipientLineUserId, m.payload.date]).sort()).toEqual([["U-Ann", D2], ["U-Bea", D2]]); // 🔻 TASK-827: per DAY — only day 2 had a co-taught class
  });
  test("one transaction: a failure on the last day rolls EVERYTHING back (no leave rows, no removal rows, the class still mine)", async () => {
    const w = world([eca("eca", D1), eca("eca3", D3, "11:00")], { busy: new Set() });
    const ex = install(w);
    const real = ex.query.bookings.findFirst;
    // make the take-off on day 3 blow up with a real fault (the transaction hands the callback the executor itself)
    ex.query.bookings.findFirst = async (q: any) => { if (Object.values(whereOf(q))[0] === "eca3" && q?.with?.additionalTeachers) throw new Error("db down on day 3"); return real(q); };
    await expect(recordRange(w, D1, D3)).rejects.toThrow("db down on day 3");
    expect(w.leave).toEqual([]);
    expect(w.removals).toEqual([]);
    expect(w.classes[0]).toMatchObject({ teacherId: ME });
  });
});

describe("🔴 CANCEL LEAVE — the teacher is put BACK (D2: as an EXTRA, at the old rate)", () => {
  test("round trip: record then lift ⇒ back on the class as an extra at 50000; the promoted Ann stays main; the removal rows and the leave day are gone", async () => {
    const w = world([eca("eca")]);
    install(w);
    await record(w, D1);
    const r: any = await sched.liftTeacherLeave(ME, D1, { onBehalf: true });
    expect(w.classes[0]).toMatchObject({ teacherId: ANN, teacherRateMinor: 61000 });
    expect(w.classes[0]!.extras).toContainEqual({ teacherId: ME, rateMinor: 50000 });
    expect(w.removals).toEqual([]);
    expect(w.leave).toEqual([]);
    expect(r).toMatchObject({ lifted: D1, teacherNotified: 1, restored: [{ bookingId: "eca", date: D1, startTime: "10:00" }] });
    // 🔴 and it CANCELS nothing, tells no family: every class is still CONFIRMED; the only LINE is to the teacher
    expect(w.classes.every((c) => c.status === "CONFIRMED")).toBe(true);
    expect(w.sent.filter((s) => s.recipientType !== "teacher")).toEqual([]);
  });
  test("🔴 a lift that restores TWO classes restores EXACTLY those two (as extras, at their own old rates) and nothing else — an unrelated class of mine is untouched", async () => {
    const w = world([eca("a", D1, "10:00"), cls("b", D1, "12:00", ANN, [[ME, 33000], [BEA, 62000]]), cls("p1", D1, "15:00", ME, [], "PRIVATE")]);
    install(w);
    await record(w, D1);
    const r: any = await sched.liftTeacherLeave(ME, D1, { onBehalf: false });
    expect(r.restored.map((x: any) => x.bookingId).sort()).toEqual(["a", "b"]);
    expect(w.classes.find((c) => c.id === "a")!.extras).toContainEqual({ teacherId: ME, rateMinor: 50000 });
    expect(w.classes.find((c) => c.id === "b")!.extras).toContainEqual({ teacherId: ME, rateMinor: 33000 });
    expect(w.classes.find((c) => c.id === "p1")).toMatchObject({ teacherId: ME, extras: [], status: "CONFIRMED" });
    expect(w.classes.every((c) => c.status === "CONFIRMED")).toBe(true);
  });
  test("a class CANCELLED meanwhile restores nothing and its rows are cleared; a class I am ALREADY on is not duplicated", async () => {
    const w = world([eca("gone"), eca("again", D1, "12:00")]);
    install(w);
    await record(w, D1);
    w.classes.find((c) => c.id === "gone")!.status = "CANCELLED";
    w.classes.find((c) => c.id === "again")!.extras.push({ teacherId: ME, rateMinor: 1 }); // the admin already re-added me by hand
    const r: any = await sched.liftTeacherLeave(ME, D1, { onBehalf: false });
    expect(w.classes.find((c) => c.id === "gone")!.extras.some((e) => e.teacherId === ME)).toBe(false);
    expect(w.classes.find((c) => c.id === "again")!.extras.filter((e) => e.teacherId === ME)).toHaveLength(1);
    expect(r.restored).toBeUndefined();
    expect(w.removals).toEqual([]);
  });
  test("a day that took the teacher off nothing: the answer is byte-identical to before (no `restored`)", async () => {
    const w = world([cls("p1", D1, "09:00", ME, [], "PRIVATE")]);
    install(w);
    await record(w, D1);
    const r: any = await sched.liftTeacherLeave(ME, D1, { onBehalf: true });
    expect(r).toEqual({ lifted: D1, teacherNotified: 1 });
  });
  test("RANGE lift: only the lifted FUTURE days restore; a kept day's removal row is not touched", async () => {
    const w = world([eca("e1", D1), eca("e2", D2, "11:00")]);
    install(w);
    const rec: any = await recordRange(w, D1, D2);
    // the first day has begun by the time of the lift (the clock moves to D1): it is KEPT, only D2 is lifted
    setSystemTime(new Date(`${D1}T10:00:00+07:00`));
    const r: any = await sched.liftTeacherLeaveRange(rec.rangeId, { onBehalf: true });
    expect(r).toMatchObject({ lifted: [D2], kept: [D1], restored: [{ bookingId: "e2", date: D2, startTime: "11:00" }] });
    expect(w.classes.find((c) => c.id === "e2")!.extras.some((e) => e.teacherId === ME)).toBe(true);
    expect(w.classes.find((c) => c.id === "e1")!.extras.some((e) => e.teacherId === ME)).toBe(false); // the kept day's class stays without me
    expect(w.removals.map((x) => x.bookingId)).toEqual(["e1"]);
  });
});

describe("🔴 the LIST shows what each day took the teacher off", () => {
  test("an item gains `continues` (with whom) ONLY when its day took the teacher off a still-live co-taught class; other items are byte-identical", async () => {
    const w = world([eca("eca", D1), cls("p2", D2, "09:00", ME, [], "PRIVATE")]);
    install(w);
    await recordRange(w, D1, D2);
    const items: any[] = await sched.listRecordedLeaveDays({ from: TODAY, to: D3 });
    expect(items.map((i) => i.date)).toEqual([D1, D2]);
    expect(items[0].continues).toEqual([{ bookingId: "eca", startTime: "10:00", with: ["Ann", "Bea"] }]);
    expect("continues" in items[1]).toBe(false);
    w.classes[0]!.status = "CANCELLED"; // cancelled meanwhile: nothing to show
    const again: any[] = await sched.listRecordedLeaveDays({ from: TODAY, to: D3 });
    expect("continues" in again[0]).toBe(false);
  });
});

describe("🔴 the PREVIEW is the act run inside a ROLLED-BACK transaction — preview = act, nothing written", () => {
  const mixed = () => world([eca("eca", D1, "10:00"), cls("p1", D1, "11:00", ME, [], "PRIVATE"), eca("blocked", D1, "12:00"), cls("grp", D1, "14:00", ME, [[ANN, 61000]], "GROUP")]);
  test("the same data previews exactly what recording does, class by class — and the preview leaves the world untouched", async () => {
    const w = mixed();
    w.busy = new Set([ANN, BEA]); // «blocked» (12:00)… but that also blocks the others: use per-class busy below
    w.busy = new Set();
    // make ONLY «blocked» undeliverable: both extras are the same two people, so give the 12:00 class its own extras who are busy
    const blocked = w.classes.find((c) => c.id === "blocked")!;
    const CAL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    w.teachers[CAL] = teacher(CAL, "Cal");
    blocked.extras = [{ teacherId: CAL, rateMinor: 70000 }];
    w.busy = new Set([CAL]);
    install(w);
    const before = JSON.stringify({ c: w.classes, l: w.leave, r: w.removals, s: w.seatMoves });
    const pv = await sched.previewTeacherLeave(ME, D1);
    expect(JSON.stringify({ c: w.classes, l: w.leave, r: w.removals, s: w.seatMoves })).toBe(before); // 🔴 nothing written
    expect(w.sent).toEqual([]);
    expect(pv.days).toHaveLength(1);
    expect(pv.days[0]).toMatchObject({ date: D1, mode: "advance" });
    const outcomes = Object.fromEntries(pv.days[0]!.classes.map((c) => [c.bookingId, c.outcome]));
    expect(outcomes).toEqual({ eca: "continues", p1: "toHandle", blocked: "cannot", grp: "continues" });
    expect(pv.days[0]!.classes.find((c) => c.bookingId === "eca")).toMatchObject({ with: ["Ann", "Bea"], promoted: ANN });
    expect(pv.counts).toEqual({ continues: 2, cancel: 0, toHandle: 1, cannot: 1 });
    // …and RECORDING the same day does exactly that
    const rec: any = await record(w, D1);
    expect(rec.continues.map((c: any) => c.bookingId).sort()).toEqual(["eca", "grp"]);
    expect(rec.toHandle.map((c: any) => c.bookingId)).toEqual(["blocked"]);
    expect(rec.bookings.map((b: any) => b.id).sort()).toEqual(["blocked", "p1"]);
  });
  test("🔴 CONDITION P: a preview leaves the database UNCHANGED and makes ZERO outbox / LINE / family-notice calls — including a GROUP promotion (seats + hold move inside the rolled-back transaction)", async () => {
    const w = world([cls("grp", D1, "14:00", ME, [[ANN, 61000]], "GROUP"), eca("eca", D1, "10:00")]);
    install(w);
    const fam = spyOn(sched, "sendClassCancelledToFamilies").mockImplementation((async () => 1) as any);
    spies.push(fam);
    const admin: any[] = [];
    spies.push(spyOn(adminLib, "notifyAdmins").mockImplementation((async (payload: any) => { admin.push(payload); }) as any));
    const snap = () => JSON.stringify({ c: w.classes, l: w.leave, r: w.removals, s: w.seatMoves });
    const before = snap();
    const pv = await sched.previewTeacherLeave(ME, D1, D1);
    expect(pv.days[0]!.classes.find((c) => c.bookingId === "grp")).toMatchObject({ outcome: "continues", promoted: ANN });
    expect(snap()).toBe(before); // 🔴 nothing written — the GROUP's seats and main teacher are as they were
    expect(w.sent).toEqual([]); // 🔴 no outbox row, no LINE, no teacher notice
    expect(fam).not.toHaveBeenCalled(); // 🔴 no family notice
    expect(admin).toEqual([]); // 🔻 TASK-829: …and no admin alert either
  });
  test("🔻 TASK-829 — a class LEFT AS IT IS (D4) is alerted to the admins ONLY by the same-day act: a PREVIEW with a D4 class makes 0 admin alerts, and so does an ADVANCE record with one (the admin recording it already sees it in the result)", async () => {
    const admin: any[] = [];
    const w = world([eca("eca")], { busy: new Set([ANN, BEA]) });
    install(w);
    spies.push(spyOn(adminLib, "notifyAdmins").mockImplementation((async (payload: any) => { admin.push(payload); }) as any));
    const pv = await sched.previewTeacherLeave(ME, D1);
    expect(pv.days[0]!.classes[0]).toMatchObject({ outcome: "cannot" });
    expect(admin).toEqual([]); // the preview
    const rec: any = await record(w, D1);
    expect(rec.toHandle.map((c: any) => c.bookingId)).toEqual(["eca"]); // the D4 class IS reported in the advance answer…
    expect(admin).toEqual([]); // …and nobody is alerted
    const range: any = await recordRange(w, D2, D3);
    expect(range.days).toHaveLength(2);
    expect(admin).toEqual([]); // a range neither
  });
  test("SAME-DAY mode: the sole class is `cancel` (not toHandle); a co-taught one continues; the last teacher's is `cancel`", async () => {
    const w = world([cls("p1", TODAY, "09:00", ME, [], "PRIVATE"), eca("eca", TODAY, "10:00"), cls("last", TODAY, "11:00", ME, [[ANN, 61000]])], { leave: [{ id: "lv-a", teacherId: ANN, date: TODAY, reason: null, createdBy: null }] });
    install(w);
    const pv = await sched.previewTeacherLeave(ME, TODAY);
    expect(pv.days[0]!.mode).toBe("same-day");
    expect(Object.fromEntries(pv.days[0]!.classes.map((c) => [c.bookingId, c.outcome]))).toEqual({ p1: "cancel", eca: "continues", last: "cancel" });
  });
  test("another teacher on leave that day FLIPS the answer: Ann away ⇒ Bea is promoted; both away ⇒ the last-teacher outcome", async () => {
    const w = world([eca("eca")], { leave: [{ id: "lv-a", teacherId: ANN, date: D1, reason: null, createdBy: null }] });
    install(w);
    expect((await sched.previewTeacherLeave(ME, D1)).days[0]!.classes[0]).toMatchObject({ outcome: "continues", promoted: BEA });
    w.leave.push({ id: "lv-b", teacherId: BEA, date: D1, reason: null, createdBy: null });
    expect((await sched.previewTeacherLeave(ME, D1)).days[0]!.classes[0]).toMatchObject({ outcome: "toHandle" });
  });
  test("a range previews each day; a PAST day is skipped; counts add up", async () => {
    const w = world([eca("e1", D1), eca("e2", D2, "11:00"), cls("old", "2026-10-20", "09:00", ME, [], "PRIVATE")]);
    install(w);
    const pv = await sched.previewTeacherLeave(ME, "2026-10-20", D2);
    expect(pv.days.map((d) => d.date)).toEqual(["2026-10-21", "2026-10-22", D1, D2]); // 10-20 is history: skipped
    expect(pv.days.every((d) => d.date >= TODAY)).toBe(true);
    expect(pv.counts.continues).toBe(2);
  });
});

describe("🔑 the teacher's own door: `GET /api/teachers/me/leave?preview=DATE` — the same route, the same key", () => {
  const rootApp = async () => (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
  const get = async (path: string) => { const res = await (await rootApp()).fetch(new Request(`http://localhost/api${path}`)); return { status: res.status, body: (await res.json()) as any }; };
  const linked = () => { process.env.SKIP_AUTH = "true"; (DEV_USER as any).isSuperAdmin = false; (DEV_USER as any).grants = new Set(["menu:calendar"]); (DEV_USER as any).teacherId = ME; };
  test("?preview=DATE answers the preview for ME; without it the route still lists my recorded days; a malformed date is 400", async () => {
    linked();
    const pv = spyOn(sched, "previewTeacherLeave").mockImplementation((async (t: string, d: string) => ({ teacherId: t, days: [], counts: { continues: 0, cancel: 0, toHandle: 0, cannot: 0 }, asked: d })) as any);
    spies.push(pv);
    spies.push(spyOn(sched, "ownLeaveDays").mockImplementation((async () => [{ date: D1, reason: null }]) as any));
    const a = await get(`/teachers/me/leave?preview=${D1}`);
    expect([a.status, pv.mock.calls[0]]).toEqual([200, [ME, D1]]);
    expect(await get("/teachers/me/leave")).toEqual({ status: 200, body: { items: [{ date: D1, reason: null }] } });
    expect((await get("/teachers/me/leave?preview=nope")).status).toBe(400);
  });
  test("🔴 a teacher's login previews ONLY its own days: a `teacherId` on that door is not a parameter at all — the service is called with the LOGGED-IN teacher; without `?preview` the old answer is byte-identical", async () => {
    linked();
    const OTHER = "99999999-9999-4999-8999-999999999999";
    const pv = spyOn(sched, "previewTeacherLeave").mockImplementation((async (t: string) => ({ teacherId: t, days: [], counts: { continues: 0, cancel: 0, toHandle: 0, cannot: 0 } })) as any);
    spies.push(pv);
    const r = await get(`/teachers/me/leave?preview=${D1}&teacherId=${OTHER}`);
    expect(r.status).toBe(200);
    expect(pv.mock.calls).toEqual([[ME, D1]]); // never OTHER
    expect(r.body.teacherId).toBe(ME);
    expect(Object.keys(v.ownLeaveQuery.parse({ preview: D1, teacherId: OTHER }))).toEqual(["preview"]); // the schema drops it
  });
  test("🔴 the ADMIN preview `GET /api/teacher-leave-days/preview?teacherId&from&to`: Teachers-only ⇒ 200, no menu ⇒ 403; the route asks for ANY teacher; a linked teacher account is not allowed", async () => {
    const { ROUTE_ACCESS } = await import("./route-access");
    expect(ROUTE_ACCESS["GET /teacher-leave-days/preview"]).toEqual({ menus: ["menu:calendar", "menu:bookings", "menu:teachers"] });
    expect(TEACHER_ALLOWED.has("GET /teacher-leave-days/preview")).toBe(false);
    process.env.SKIP_AUTH = "true";
    const pv = spyOn(sched, "previewTeacherLeave").mockImplementation((async (t: string) => ({ teacherId: t, days: [], counts: { continues: 0, cancel: 0, toHandle: 0, cannot: 0 } })) as any);
    spies.push(pv);
    const set = (grants: string[]) => { (DEV_USER as any).isSuperAdmin = false; (DEV_USER as any).grants = new Set(grants); (DEV_USER as any).teacherId = null; };
    set(["menu:teachers"]);
    const ok = await get(`/teacher-leave-days/preview?teacherId=${ME}&from=${D1}&to=${D2}`);
    expect([ok.status, pv.mock.calls[0]]).toEqual([200, [ME, D1, D2]]);
    set(["menu:students"]);
    expect((await get(`/teacher-leave-days/preview?teacherId=${ME}&from=${D1}`)).status).toBe(403);
    set(["menu:teachers"]);
    expect((await get(`/teacher-leave-days/preview?teacherId=${ME}&from=${D3}&to=${D1}`)).status).toBe(400); // to before from: the approved refusal
  });
  test("no new door: the route is already a teacher-allowed one, and the query schema takes only `preview`", () => {
    expect(TEACHER_ALLOWED.has("GET /teachers/me/leave")).toBe(true);
    expect(v.ownLeaveQuery.safeParse({ preview: D1 }).success).toBe(true);
    expect(v.ownLeaveQuery.safeParse({}).success).toBe(true);
    expect(v.ownLeaveQuery.safeParse({ preview: "2026-13-99x" }).success).toBe(false);
    // the ADMIN preview's query is built and validated here; its ROUTE waits for its access line
    expect(v.leavePreviewQuery.safeParse({ teacherId: ME, from: D1, to: D3 }).success).toBe(true);
    expect(v.leavePreviewQuery.safeParse({ teacherId: ME, from: D3, to: D1 }).success).toBe(false);
    expect(v.leavePreviewQuery.safeParse({ teacherId: ME, from: "2026-10-01", to: "2026-11-30" }).success).toBe(false);
  });
});

describe("🔑 by source and by shape — the migration, one remembered write, restore BEFORE delete, the contract", () => {
  const SVC = code(read("src/services/scheduler.service.ts"));
  const LIB = code(read("src/lib/teacher-leave.ts"));
  test("migration 0071: the table + its unique index (the LAST object), IF NOT EXISTS, no data; journal idx 71; the witness probes the index; the schema declares it; 72 files = 72 entries", () => {
    const sql = read("drizzle/0071_teacher_leave_removals.sql").replace(/^--.*$/gm, "");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "teacher_leave_removals" (');
    expect(sql.lastIndexOf("CREATE UNIQUE INDEX IF NOT EXISTS")).toBeGreaterThan(sql.indexOf("CREATE TABLE IF NOT EXISTS"));
    expect(sql).toContain('"leave_day_id" uuid NOT NULL REFERENCES "teacher_leave_days"("id") ON DELETE CASCADE');
    expect(sql).toContain('"booking_id" uuid NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE');
    expect(sql).not.toMatch(/INSERT|UPDATE |DELETE FROM/i);
    const journal = JSON.parse(read("drizzle/meta/_journal.json"));
    expect(journal.entries.find((e: any) => e.tag === "0071_teacher_leave_removals")).toMatchObject({ idx: 71, breakpoints: true });
    expect(SCHEDULING_WITNESSES.find((x) => x.tag === "0071_teacher_leave_removals")).toMatchObject({ probe: { kind: "index", index: "teacher_leave_removals_day_booking_uq" }, rerunnable: true });
    expect(code(read("src/db/schema.ts"))).toContain('export const teacherLeaveRemovals = pgTable(');
  });
  test("the removal row is written in ONE place (inside the take-off), from the take-off's own outcome; it is read in ONE place per purpose (restore · list)", () => {
    expect([...SVC.matchAll(/insert\(teacherLeaveRemovals\)/g)]).toHaveLength(1);
    expect(region(SVC, "async function takeOffCoTaughtForLeaveDay(", "\n}\n")).toContain("insert(teacherLeaveRemovals).values({ leaveDayId: leaveId, bookingId: b.id, teacherId: me, date, wasMain: out.wasMain, rateMinor: out.oldRateMinor })");
    expect([...SVC.matchAll(/from\(teacherLeaveRemovals\)/g)]).toHaveLength(2); // restore + the list
  });
  test("Cancel leave restores BEFORE the leave day goes (per day and per range); the restore inserts an EXTRA only and never touches the main", () => {
    const L = region(SVC, "export async function liftTeacherLeave(", "\n}\n");
    expect(L.indexOf("restoreRemovedTeachers(")).toBeLessThan(L.indexOf("liftAdvanceLeave("));
    expect(LIB).toContain("if (future.length && beforeDelete) await beforeDelete(rows[0]!.teacherId, future);");
    expect(LIB.indexOf("await beforeDelete(")).toBeLessThan(LIB.indexOf("await exec.delete(teacherLeaveDays).where(and(eq(teacherLeaveDays.rangeId, rangeId)"));
    const R = region(SVC, "export async function restoreRemovedTeachers(", "\n}\n");
    expect(R).toContain("insert(bookingTeachers).values({ bookingId: r.bookingId, teacherId, rateMinor: r.rateMinor }).onConflictDoNothing()");
    expect(R).not.toMatch(/update\(|teacherId:\s*teacherId\s*\}\)\.where|delete\(bookingTeachers\)/);
  });
  test("the preview NEVER commits: it ends only by throwing the rollback sentinel, and asks the day's side of the fork through the lib's one helper", () => {
    const P = region(SVC, "export async function previewTeacherLeave(", "\n}\n");
    expect(P).toContain("throw new PreviewRollback(");
    expect(P).toContain("leaveModeOf(date)");
    expect(P).not.toMatch(/isAdvanceLeave\(|\.insert\(|\.update\(|enqueueLine|notifyTeacherOfLeaveDay/);
    expect([...P.matchAll(/db\.transaction\(/g)]).toHaveLength(1);
  });
  test("the contract publishes every answer type for the front (824–826)", () => {
    const C = code(read("src/types/contract.ts"));
    for (const name of ["LeaveContinuedClassDTO", "LeaveToHandleClassDTO", "LeaveCoachNoticeDTO", "LeaveSplitDTO", "SameDayLeaveResponse", "RecordLeaveDayResponse", "RecordLeaveRangeResponse", "RestoredClassDTO", "LiftLeaveDayResponse", "LiftLeaveRangeResponse", "RecordedLeaveDayDTO", "LeavePreviewResponse", "LeavePreviewDayDTO", "LeavePreviewClassDTO", "LeavePreviewCountsDTO"]) {
      expect({ name, declared: new RegExp(`export (interface|type) ${name}\\b`).test(C) }).toEqual({ name, declared: true });
    }
    expect(region(C, "export interface LeavePreviewClassDTO {", "\n}\n") + "}").toContain('outcome: LeavePreviewOutcome');
    expect(C).toContain('export type LeavePreviewOutcome = "continues" | "cancel" | "toHandle" | "cannot";');
  });
});
