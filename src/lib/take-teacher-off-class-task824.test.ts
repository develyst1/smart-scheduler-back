// TASK-824 (REQ-125 ruling B, DESIGN §1) — the building block "take ONE teacher off ONE class", by value through a fake transaction.
//   · an EXTRA → their `booking_teachers` row goes, nothing else;
//   · the MAIN → the next ELIGIBLE extra (D1: NAME order) becomes main: `teacher_id` ← them, their extra row removed, THEIR OWN stored rate → `teacher_rate_minor`; a GROUP row moves through the group swap's own internals
//     (`moveGroupRowToTeacher`: the seats follow, its refusals stand — D3);
//   · "eligible" = remains (not on leave that day, not leaving in the same act) AND able to take the main seat — tried in a SAVEPOINT, so a refusal / taken slot means «the next one» and leaves nothing behind;
//   · none eligible (D4) / no teacher remains ⇒ `cannot`, the class left EXACTLY as it was; courses, vouchers, trials, 1 HR (one teacher) are never touched.
// No caller is wired here (825/826 wire it): this file pins the block and its reuse of the swap.
import { describe, expect, setSystemTime, test, afterEach } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { bookings, bookingTeachers } from "../db/schema";
import * as sched from "../services/scheduler.service";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const SVC = readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => { const a = s.indexOf(from); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf(to, a + from.length)); };
const dialect = new PgDialect();
afterEach(() => setSystemTime());

const BK = "99999999-9999-4999-8999-999999999999";
const M = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // the teacher who leaves (the main)
const ANN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", BEA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", CAL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DATE = "2026-10-21";
const teacher = (id: string, nickname: string, extra: object = {}) => ({ id, name: nickname, nickname, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME", ...extra });

type World = {
  booking: { id: string; date: string; teacherId: string; teacherRateMinor: number | null; bookingType: string; status: string };
  extras: Array<{ teacherId: string; rateMinor: number | null }>;
  teachers: Record<string, any>;
  leave: Array<{ teacherId: string; date: string }>;
  busy: Set<string>; // teachers whose slot index would refuse them as MAIN (they hold another class that hour)
  failSeatFor: Set<string>; // GROUP: the seat write fails AFTER the main row moved (the savepoint must undo the main row)
  seatMoves: string[];
  deletes: string[];
};
const world = (over: Partial<World> = {}): World => ({
  booking: { id: BK, date: DATE, teacherId: M, teacherRateMinor: 50000, bookingType: "OTHER", status: "CONFIRMED" },
  extras: [{ teacherId: ANN, rateMinor: 61000 }, { teacherId: BEA, rateMinor: 62000 }],
  teachers: { [M]: teacher(M, "Mod"), [ANN]: teacher(ANN, "Ann"), [BEA]: teacher(BEA, "Bea"), [CAL]: teacher(CAL, "Cal") },
  leave: [], busy: new Set(), failSeatFor: new Set(), seatMoves: [], deletes: [],
  ...over,
});
const whereOf = (q: any): Record<string, unknown> => {
  const pairs = [q?.where?.(new Proxy({}, { get: (_t, k) => String(k) }), { and: (...a: any[]) => a.flat(), eq: (c: string, v: unknown) => [[c, v]] })].flat(3);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < pairs.length; i += 2) out[pairs[i] as string] = pairs[i + 1];
  return out;
};
const paramsOf = (w: unknown) => dialect.sqlToQuery(w as any).params as unknown[];
const pgErr = (code: string) => Object.assign(new Error("pg"), { code });

function fakeTx(w: World) {
  const snap = () => JSON.stringify({ b: w.booking, e: w.extras, s: w.seatMoves, d: w.deletes });
  const restore = (s: string) => { const o = JSON.parse(s); w.booking = o.b; w.extras = o.e; w.seatMoves = o.s; w.deletes = o.d; };
  const tx: any = {
    query: {
      bookings: { findFirst: async (q: any) => {
        if (q?.with?.additionalTeachers) return { ...w.booking, additionalTeachers: w.extras.map((e) => ({ teacherId: e.teacherId, rateMinor: e.rateMinor, teacher: w.teachers[e.teacherId] })) };
        if (q?.columns?.bookingType) return { bookingType: w.booking.bookingType, groupId: null };
        if (q?.columns?.id) return { id: w.booking.id, date: w.booking.date, status: w.booking.status };
        return w.booking;
      } },
      teachers: { findFirst: async (q: any) => { const id = Object.values(whereOf(q))[0] as string; return w.teachers[id]; } },
      teacherLeaveDays: { findFirst: async (q: any) => { const x = whereOf(q); return w.leave.find((l) => l.teacherId === x.teacherId && l.date === x.date); } },
      boMovement: { findMany: async () => [] },
      boItem: { findFirst: async () => undefined },
    },
    update: (table: any) => ({ set: (v: any) => ({ where: async (cond: unknown) => {
      expect(table).toBe(bookings);
      if ("teacherRateMinor" in v) { // the MAIN row
        if (w.busy.has(v.teacherId)) throw pgErr("23505");
        w.booking.teacherId = v.teacherId; w.booking.teacherRateMinor = v.teacherRateMinor;
      } else { // the seats of a group row
        if (w.failSeatFor.has(v.teacherId)) throw Object.assign(new Error("seat write refused"), { __apiRefusal: true });
        w.seatMoves.push(v.teacherId);
      }
      void cond;
    } }) }),
    delete: (table: any) => ({ where: async (cond: unknown) => {
      expect(table).toBe(bookingTeachers);
      const [bookingId, teacherId] = paramsOf(cond) as string[];
      expect(bookingId).toBe(BK);
      w.extras = w.extras.filter((e) => e.teacherId !== teacherId);
      w.deletes.push(teacherId!);
    } }),
    transaction: async (cb: any) => { const s = snap(); try { return await cb(tx); } catch (e) { restore(s); throw e; } },
  };
  return tx;
}
const take = (w: World, teacherId: string, opts: { alsoLeaving?: ReadonlySet<string> } = {}) => { setSystemTime(new Date("2026-10-18T10:00:00+07:00")); return sched.takeTeacherOffClass(fakeTx(w), BK, teacherId, opts); };
const unchanged = (w: World, ref: World) => expect({ b: w.booking, e: w.extras, s: w.seatMoves, d: w.deletes }).toEqual({ b: ref.booking, e: ref.extras, s: ref.seatMoves, d: ref.deletes });

describe("🔴 an EXTRA teacher leaves — their row goes, nothing else", () => {
  test("removedExtra: only my booking_teachers row is deleted; the main, the rate and the other extras are untouched; my stored rate is returned", async () => {
    const w = world();
    const out = await take(w, BEA);
    expect(out).toEqual({ outcome: "removedExtra", wasMain: false, oldRateMinor: 62000 });
    expect(w.extras.map((e) => e.teacherId)).toEqual([ANN]);
    expect([w.booking.teacherId, w.booking.teacherRateMinor]).toEqual([M, 50000]);
    expect(w.deletes).toEqual([BEA]);
  });
  test("an extra with no stored rate returns null (nothing is invented)", async () => {
    const w = world({ extras: [{ teacherId: ANN, rateMinor: null }, { teacherId: BEA, rateMinor: 62000 }] });
    expect(await take(w, ANN)).toEqual({ outcome: "removedExtra", wasMain: false, oldRateMinor: null });
  });
});

describe("🔴 the MAIN teacher leaves — the next ELIGIBLE extra (D1: name order) becomes main, on THEIR OWN rate", () => {
  test("Ann (first by name) is promoted: teacher_id ← Ann, teacher_rate_minor ← ANN'S 61000 (not the outgoing 50000), her extra row removed, Bea stays an extra; the outgoing rate is returned", async () => {
    const w = world();
    const out = await take(w, M);
    expect(out).toEqual({ outcome: "promoted", wasMain: true, teacherId: ANN, oldRateMinor: 50000, newRateMinor: 61000 });
    expect([w.booking.teacherId, w.booking.teacherRateMinor]).toEqual([ANN, 61000]);
    expect(w.extras.map((e) => e.teacherId)).toEqual([BEA]);
  });
  test("D1 is NAME order, not insertion order: the extras listed Bea-first still promote Ann", async () => {
    const w = world({ extras: [{ teacherId: BEA, rateMinor: 62000 }, { teacherId: ANN, rateMinor: 61000 }] });
    expect((await take(w, M)) as any).toMatchObject({ outcome: "promoted", teacherId: ANN });
  });
  test("an extra ON LEAVE that day is skipped (THE reader): Ann is away ⇒ Bea becomes main, on Bea's rate; Ann stays an extra", async () => {
    const w = world({ leave: [{ teacherId: ANN, date: DATE }] });
    const out = await take(w, M);
    expect(out).toMatchObject({ outcome: "promoted", teacherId: BEA, newRateMinor: 62000 });
    expect(w.extras.map((e) => e.teacherId)).toEqual([ANN]);
  });
  test("an extra leaving IN THE SAME ACT is skipped: alsoLeaving {Ann} ⇒ Bea", async () => {
    const w = world();
    expect((await take(w, M, { alsoLeaving: new Set([ANN]) })) as any).toMatchObject({ outcome: "promoted", teacherId: BEA });
  });
  test("🔑 a taken slot (bookings_teacher_slot_uq) is «try the next one», and the failed attempt leaves NOTHING behind: Ann's slot is taken ⇒ Bea; Ann is still an extra", async () => {
    const w = world({ busy: new Set([ANN]) });
    const out = await take(w, M);
    expect(out).toMatchObject({ outcome: "promoted", teacherId: BEA });
    expect(w.extras.map((e) => e.teacherId)).toEqual([ANN]);
    expect(w.deletes).toEqual([BEA]); // ONLY the promoted teacher's extra row was deleted
  });
  test("🔴 D4: nobody can take the main seat (every candidate's slot is taken) ⇒ `cannot`, the class EXACTLY as it was — no change, no delete", async () => {
    const w = world({ busy: new Set([ANN, BEA]) });
    const ref = world({ busy: new Set([ANN, BEA]) });
    const out = await take(w, M);
    expect(out).toMatchObject({ outcome: "cannot", wasMain: true, reason: "no-eligible-main", oldRateMinor: 50000 });
    unchanged(w, ref);
  });
  test("a real FAULT (not a refusal) is never swallowed as «try the next one»", async () => {
    const w = world();
    const tx = fakeTx(w);
    const real = tx.update;
    tx.update = () => { throw new Error("connection lost"); };
    setSystemTime(new Date("2026-10-18T10:00:00+07:00"));
    await expect(sched.takeTeacherOffClass(tx, BK, M)).rejects.toThrow("connection lost");
    tx.update = real;
  });
});

describe("🔴 «a teacher remains» — and when none does, NOTHING changes", () => {
  test("every other teacher is on leave that day ⇒ `cannot` / no-teacher-remains for the main AND for an extra; no row touched", async () => {
    for (const leaving of [M, ANN]) {
      const w = world({ leave: [{ teacherId: leaving === M ? ANN : M, date: DATE }, { teacherId: BEA, date: DATE }] });
      const ref = world({ leave: w.leave });
      const out = await take(w, leaving);
      expect(out).toMatchObject({ outcome: "cannot", reason: "no-teacher-remains" });
      unchanged(w, ref);
    }
  });
  test("a class with ONE teacher (a course, a voucher, a trial, 1 HR — no extras by construction) ⇒ no teacher remains ⇒ untouched", async () => {
    for (const type of ["COURSE_PACKAGE", "VOUCHER", "TRIAL", "PRIVATE"]) {
      const w = world({ extras: [], booking: { id: BK, date: DATE, teacherId: M, teacherRateMinor: 50000, bookingType: type, status: "CONFIRMED" } });
      const ref = world({ extras: [], booking: { ...w.booking } });
      expect(await take(w, M)).toMatchObject({ outcome: "cannot", reason: "no-teacher-remains", wasMain: true, oldRateMinor: 50000 });
      unchanged(w, ref);
    }
  });
  test("remainingTeachersOf: the OTHER teachers who are not on leave and not leaving in the same act", async () => {
    setSystemTime(new Date("2026-10-18T10:00:00+07:00"));
    const w = world({ leave: [{ teacherId: BEA, date: DATE }] });
    expect(await sched.remainingTeachersOf(fakeTx(w), BK, M)).toEqual([ANN]);
    expect(await sched.remainingTeachersOf(fakeTx(w), BK, ANN)).toEqual([M]);
    expect(await sched.remainingTeachersOf(fakeTx(w), BK, M, new Set([ANN]))).toEqual([]);
  });
  test("a teacher who is not on the class at all is a caller bug (an Error, not a silent no-op)", async () => {
    await expect(take(world(), CAL)).rejects.toThrow("not on this class");
  });
});

describe("🔴 a GROUP row — the swap's own internals: the seats follow, its refusals stand (D3)", () => {
  const group = (over: Partial<World> = {}) => world({ booking: { id: BK, date: DATE, teacherId: M, teacherRateMinor: 50000, bookingType: "GROUP", status: "CONFIRMED" }, ...over });
  test("the main coach leaves: Ann becomes main on her own rate AND the live seats follow to Ann", async () => {
    const w = group();
    const out = await take(w, M);
    expect(out).toMatchObject({ outcome: "promoted", teacherId: ANN, newRateMinor: 61000 });
    expect([w.booking.teacherId, w.booking.teacherRateMinor]).toEqual([ANN, 61000]);
    expect(w.seatMoves).toEqual([ANN]);
    expect(w.extras.map((e) => e.teacherId)).toEqual([BEA]);
  });
  test("D3: the swap's refusal (Ann is archived ⇒ `assertTeacherBookable` refuses) ⇒ the next candidate; nothing of Ann's attempt remains", async () => {
    const w = group({ teachers: { [M]: teacher(M, "Mod"), [ANN]: teacher(ANN, "Ann", { archived: true }), [BEA]: teacher(BEA, "Bea") } });
    const out = await take(w, M);
    expect(out).toMatchObject({ outcome: "promoted", teacherId: BEA });
    expect(w.seatMoves).toEqual([BEA]);
    expect(w.extras.map((e) => e.teacherId)).toEqual([ANN]);
  });
  test("D3 + D4: every candidate refused ⇒ `cannot`, the group row and its seats as they were, the refusal's words carried", async () => {
    const w = group({ teachers: { [M]: teacher(M, "Mod"), [ANN]: teacher(ANN, "Ann", { archived: true }), [BEA]: teacher(BEA, "Bea", { archived: true }) } });
    const ref = group({ teachers: w.teachers });
    const out: any = await take(w, M);
    expect(out).toMatchObject({ outcome: "cannot", reason: "no-eligible-main" });
    expect(out.message).toContain("ถูกปิดการใช้งานแล้ว");
    unchanged(w, ref);
  });
  test("🔑 the SAVEPOINT undoes a half-done attempt: Ann's main-row move succeeds but her SEAT write is refused ⇒ the main row is put back and Bea is tried", async () => {
    const { ApiException } = await import("../lib/http");
    const w = group();
    const tx = fakeTx(w);
    const upd = tx.update;
    tx.update = (t: any) => ({ set: (v: any) => ({ where: async (c: unknown) => {
      if (!("teacherRateMinor" in v) && v.teacherId === ANN) throw new ApiException(409, "SEAT_REFUSED", "seat write refused");
      return upd(t).set(v).where(c);
    } }) });
    setSystemTime(new Date("2026-10-18T10:00:00+07:00"));
    const out = await sched.takeTeacherOffClass(tx, BK, M);
    expect(out).toMatchObject({ outcome: "promoted", teacherId: BEA });
    expect(w.booking.teacherId).toBe(BEA); // not Ann: her half-done move was undone before Bea's
    expect(w.seatMoves).toEqual([BEA]);
    expect(w.extras.map((e) => e.teacherId)).toEqual([ANN]);
  });
  test("an EXTRA coach leaves a group: their row goes; the seats and the main coach are untouched", async () => {
    const w = group();
    expect(await take(w, BEA)).toMatchObject({ outcome: "removedExtra", oldRateMinor: 62000 });
    expect(w.seatMoves).toEqual([]);
    expect(w.booking.teacherId).toBe(M);
  });
});

describe("🔑 by source — ONE block, reusing the swap's internals; it cancels and tells nobody", () => {
  const SW = code(SVC);
  const BLOCK = code(region(SVC, "export async function takeTeacherOffClass(", "\n}\n"));
  test("`swapGroupTeacher` and the block both call `moveGroupRowToTeacher` — the loop body was MOVED, not copied (exactly two callers)", () => {
    expect(SW).toContain("await moveGroupRowToTeacher(tx, g, input, rate);");
    expect(SW).toContain("await moveGroupRowToTeacher(sp, g, { teacherId: cand.teacherId }, newRate);");
    expect([...SW.matchAll(/moveGroupRowToTeacher\(/g)]).toHaveLength(3); // the definition + the two calls
    // the swap's loop no longer carries its own copy of the writes
    expect(code(region(SVC, "export async function swapGroupTeacher(", "\n}\n"))).not.toContain("reconcileBookingHolds(");
  });
  test("the block writes ONLY the join table's extra row and (for the main) the class's teacher + rate — no cancel, no notice, no family, no new row", () => {
    expect(BLOCK).not.toMatch(/CANCELLED|enqueueLine|notify|sendClass|insert\(|addLeaveWeek|reconcileCoursePlan/);
    expect([...BLOCK.matchAll(/delete\(bookingTeachers\)/g)]).toHaveLength(2); // an extra leaving · the promoted extra's row
    expect(BLOCK).toContain("teacherRateMinor: newRate");
    expect(BLOCK).toContain("const newRate = cand.rateMinor; // THEIR OWN stored rate");
  });
  test("D1 sorts by the nickname the calendar sorts by (Thai collation), then the full name, then the id; the attempt is a SAVEPOINT; a non-refusal is rethrown", () => {
    expect(BLOCK).toContain('.sort((x, y) => x.nickname.localeCompare(y.nickname, "th") || x.name.localeCompare(y.name, "th") || x.teacherId.localeCompare(y.teacherId));');
    expect(BLOCK).toContain("await tx.transaction(async (sp: any) => {");
    expect(BLOCK).toContain("if (!(e instanceof ApiException)) throw e;");
  });
  test("«remains» asks THE reader for the leave (`teacherLeaveOn`) and the same-act set — no second rule", () => {
    const R = code(region(SVC, "async function remainingOf(", "\n}\n"));
    expect(R).toContain("t.teacherId !== leavingTeacherId && !alsoLeaving.has(t.teacherId)");
    expect(R).toContain("if (!(await teacherLeaveOn(exec, t.teacherId, c.date))) out.push(t);");
  });
});

describe("🔴 the rate-shaped OUTCOME keys never reach an HTTP response body (the condition on classing `oldRateMinor` / `newRateMinor` as not-a-coach-rate)", () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(d, e.name)] : []));
  const files = walk(resolve(root, "src"));
  const src = (f: string) => code(readFileSync(f, "utf8").replace(/\r\n/g, "\n"));
  const rel = (f: string) => relative(root, f).replace(/\\/g, "/"); // from the test's own root — never the checkout folder's name
  test("the keys exist ONLY in scheduler.service.ts — in the block, and (826) as the value STORED in the removal table — not in a route, a DTO, the contract or the OpenAPI document", () => {
    expect(files.filter((f) => /oldRateMinor|newRateMinor/.test(src(f))).map(rel)).toEqual(["src/services/scheduler.service.ts"]);
    const S = src(resolve(root, "src/services/scheduler.service.ts"));
    const outside = S.replace(region(S, "export type TakeOffOutcome =", "type ClassTeachers"), "").replace(region(S, "export async function takeTeacherOffClass(", "\n}\n"), "");
    // 🔻 TASK-826 — the ONE other mention: the leaving teacher's old rate goes INTO the removal row (so Cancel leave can restore it) — a table write, never a response value
    expect([...outside.matchAll(/oldRateMinor|newRateMinor/g)]).toHaveLength(1);
    expect(region(S, "async function takeOffCoTaughtForLeaveDay(", "\n}\n")).toContain("rateMinor: out.oldRateMinor");
  });
  test("🔻 TASK-826 — the callers are NAMED: the definition, the same-day act (825), the advance record (826) and the preview (826); none of their answers carries a rate key", () => {
    expect(files.filter((f) => /takeTeacherOffClass\(/.test(src(f))).map(rel)).toEqual(["src/services/scheduler.service.ts"]);
    const S = src(resolve(root, "src/services/scheduler.service.ts"));
    expect([...S.matchAll(/takeTeacherOffClass\(/g)]).toHaveLength(4); // the definition + the same-day act + the advance record + the preview
    expect(region(S, "export async function reportTeacherLeave(", "export type SameDayContinuedClass")).toContain("await takeTeacherOffClass(tx, b.id, me);");
    expect(region(S, "async function takeOffCoTaughtForLeaveDay(", "\n}\n")).toContain("await takeTeacherOffClass(tx, b.id, me);");
    expect(region(S, "export async function previewTeacherLeave(", "\n}\n")).toContain("await takeTeacherOffClass(tx, b.id, teacherId);");
    // the answers those callers build never read or return a rate: the keys stay in-process
    const answers = region(S, "export async function reportTeacherLeave(", "export type SameDayContinuedClass") + region(S, "export type SameDayContinuedClass", "async function describeContinuation(")
      + region(S, "async function reportTeacherLeaveRange(", "export async function reportTeacherLeave(") + region(S, "export async function previewTeacherLeave(", "\n}\n");
    expect(answers).not.toMatch(/oldRateMinor|newRateMinor|RateMinor/);
  });
});
