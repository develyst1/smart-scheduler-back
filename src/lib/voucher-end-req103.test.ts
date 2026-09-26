// TASK-439 (`REQ-103`, SPEC-089 B) — a WHOLE voucher cancelled on the course-end shape: migration `0051` (three nullable
// columns + the CHECK ⇔ `END_REASONS` as witness; 56 = 56), `voucherStatus` (ENDED > EXPIRED > EXHAUSTED > ACTIVE) on the DTO,
// `endableVoucherDraws` (live AND today-or-later — the past is the day-end's), `voucherUsable` refusing an ended voucher FIRST
// (the draw / the picker / the SOM through the ONE gate; the creator's 409 before any write), `endVoucher` by value through a
// fake tx (the doomed rows CANCELLED + note + `cancel_reason` + holds reconciled per row, `used_hours` never written, the stamp,
// ALREADY_ENDED, ONE coach notice per coach for the CONFIRMED draws with `cause: "voucher_ended"`, no family notice), the
// preview's shape (the course's + `remaining`), the routes under the course-cancel key, the renderer byte-identical to an END
// (`<subject> 10 HR`, no new bytes), the course end's NEW holds line, and the undo on an ENDED voucher left open.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { END_REASONS } from "./course-plan";
import { formatOutboxMessage } from "./line-message";
import { ROUTE_ACCESS } from "./route-access";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { VOUCHER_ENDED_MESSAGE, VOUCHER_STATUSES, endableVoucherDraws, isVoucherEnded, voucherStatus, voucherUsable } from "./voucher";
import { voucherEligible } from "./eligibility";
import * as sched from "../services/scheduler.service";
import { db } from "../db";
import { bookings, notificationOutbox, vouchers } from "../db/schema";
import { toVoucherDTO } from "../db/mappers";
import { readSrc } from "./read-src";
import { addDays, fmtDate } from "./time";
import { PgDialect } from "drizzle-orm/pg-core"; // TASK-512
import * as ownScope from "./own-scope";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const json = (method: string, path: string, body?: unknown) =>
  rootApp.fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const SVC = code(src("src/services/scheduler.service.ts"));
const V = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", S1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", T2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });

const TODAY = fmtDate(new Date()); // the service's own "today" (local, not UTC — the two differ for seven hours a day here)
const shift = (days: number) => addDays(TODAY, days);
const draw = (over: any = {}) => ({ id: `b-${over.date ?? "x"}-${over.status ?? "P"}`, date: shift(7), startTime: "15:00:00", endTime: "16:00:00", status: "PENDING", bookingType: "VOUCHER", teacherId: T1, voucherId: V, studentId: S1, subject: { name: "Freeskate" }, teacher: { id: T1, nickname: "Ek", name: "Ek" }, student: { id: S1, name: "มะขิด", nickname: "ขิด" }, coStudent: null, ...over });
const voucher = (over: any = {}) => ({ id: V, studentId: S1, totalHours: 10, usedHours: 3, expiryDate: shift(60), source: "SALE", endedAt: null, endedBy: null, endReason: null, student: { id: S1, name: "มะขิด", nickname: "ขิด" }, ...over });

/** A fake tx over one voucher + its rows: records every write; the reconcile's reads are probed (one `boMovement` read per row). */
const fakeTx = (v: any, rows: any[]) => {
  const writes: any[] = [];
  const reconciled: string[] = [];
  const tx: any = {
    query: {
      vouchers: { findFirst: async () => v },
      bookings: {
        findMany: async () => rows,
        findFirst: async ({ where }: any) => { const probe: any[] = []; try { where({ id: "id" }, { eq: (_c: any, val: any) => { probe.push(val); return val; }, and: (...a: any[]) => a }); } catch {} return { bookingType: "VOUCHER", groupId: null, id: probe[0] }; },
      },
      boMovement: { findMany: async ({ where }: any) => { const probe: any[] = []; try { where({ refId: "refId", refType: "refType" }, { and: (...a: any[]) => a, eq: (_c: any, val: any) => { probe.push(val); return val; }, inArray: () => null }); } catch {} reconciled.push(probe[0]); return []; } },
      teachers: { findFirst: async ({ where }: any) => { const probe: any[] = []; try { where({ id: "id" }, { eq: (_c: any, val: any) => { probe.push(val); return val; } }); } catch {} return { id: probe[0], type: "FULL_TIME", nickname: probe[0] === T1 ? "Ek" : "Ple", lineUserId: probe[0] === T1 ? "U1" : "U2" }; } },
      boItem: { findMany: async () => [], findFirst: async () => null },
      appSettings: { findMany: async () => [], findFirst: async () => null },
    },
    insert: (table: any) => ({ values: (val: any) => { writes.push({ op: "insert", table: table === notificationOutbox ? "outbox" : "other", val }); const ret = { returning: async () => [{ id: "new" }], onConflictDoNothing: async () => {} }; return Object.assign(Promise.resolve(), ret); } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: async (w: any) => { writes.push({ op: "update", table: table === bookings ? "bookings" : table === vouchers ? "vouchers" : "other", patch, where: String(w) }); } }) }),
    // TASK-512 — the bulk coach notice asks `teachersOfBooking` (`select … from teachers inner join bookings on id = $1 and <THE predicate>`):
    // answered from these rows — their primary coach (none of these draws has an additional teacher).
    select: () => ({ from: () => ({ where: async () => [], innerJoin: async (_t: any, cond: any) => {
      const id = new PgDialect().sqlToQuery(cond).params[0];
      const r = rows.find((x) => x.id === id);
      return r?.teacherId ? [{ id: r.teacherId, lineUserId: r.teacherId === T1 ? "U1" : r.teacherId === T2 ? "U2" : null }] : [];
    } }) }),
  };
  return { tx, writes, reconciled };
};

describe("🔴 the migration — 0051, counted, three nullable columns on a small table, the CHECK NOT VALID → VALIDATE = the witness; the CHECK ⇔ END_REASONS", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
  const sql = readFileSync(resolve(root, "drizzle/0051_voucher_end.sql"), "utf8").replace(/\r\n/g, "\n");
  test("56 = 56: `0051_voucher_end` is the 52nd file, idx 51 (TASK-443 added 0052 after it); 'expects 52'; the six statements", () => {
    expect(files.length).toBe(60); // TASK-497: +0059
    expect(journal.entries.length).toBe(60); // TASK-497: +0059
    expect(files[51]).toBe("0051_voucher_end.sql");
    expect(journal.entries[51]).toMatchObject({ idx: 51, tag: "0051_voucher_end" });
    expect(sql).toContain("`db:verify` expects 52");
    const stmts = sql.split("--> statement-breakpoint").map((s) => s.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(stmts).toEqual([
      `ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;`,
      `ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "ended_by" text;`,
      `ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "end_reason" text;`,
      `ALTER TABLE "vouchers" DROP CONSTRAINT IF EXISTS "vouchers_end_reason_chk";`,
      `ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_end_reason_chk" CHECK ("end_reason" IS NULL OR "end_reason" IN ('PROGRAM_CHANGED', 'CUSTOMER_CANCELLED', 'ADMIN_ERROR', 'TEACHER_LEAVE')) NOT VALID;`,
      `ALTER TABLE "vouchers" VALIDATE CONSTRAINT "vouchers_end_reason_chk";`,
    ]);
  });
  test("🔴 the CHECK's list ⇔ `END_REASONS` by value — a fifth code on either side fails here", () => {
    const list = /"end_reason" IN \(([^)]*)\)/.exec(sql)![1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(list).toEqual([...END_REASONS]);
  });
  test("the witness is the LAST entry, a constraint-def probe on the 4th code; the schema's three columns", () => {
    const last = SCHEDULING_WITNESSES.find((w) => w.tag === "0051_voucher_end")!; // 🔻 TASK-443: 0052 is the last now
    expect(last).toMatchObject({ tag: "0051_voucher_end", probe: { kind: "constraint-def", constraint: "vouchers_end_reason_chk", contains: "TEACHER_LEAVE" }, rerunnable: true });
    const VS = region(code(src("src/db/schema.ts")), "export const vouchers = pgTable(", "\n});");
    expect(VS).toContain('endedAt: timestamp("ended_at", { withTimezone: true }),');
    expect(VS).toContain('endedBy: text("ended_by"),');
    expect(VS).toContain('endReason: text("end_reason"),');
  });
});

describe("🔴 the pure rules by value — status precedence, the gate refuses ENDED first, the doomed set is FUTURE live only", () => {
  test("`voucherStatus`: ENDED > EXPIRED > EXHAUSTED > ACTIVE — an ended-and-expired voucher reads ENDED; the closed set", () => {
    expect(VOUCHER_STATUSES).toEqual(["ACTIVE", "EXHAUSTED", "EXPIRED", "ENDED"]);
    expect(voucherStatus(voucher(), TODAY)).toBe("ACTIVE");
    expect(voucherStatus(voucher({ usedHours: 10 }), TODAY)).toBe("EXHAUSTED");
    expect(voucherStatus(voucher({ expiryDate: shift(-1) }), TODAY)).toBe("EXPIRED");
    expect(voucherStatus(voucher({ expiryDate: shift(-1), usedHours: 10 }), TODAY)).toBe("EXPIRED");
    expect(voucherStatus(voucher({ endedAt: new Date(), expiryDate: shift(-1), usedHours: 10 }), TODAY)).toBe("ENDED");
    expect(voucherStatus(voucher({ endedAt: "2026-09-22T10:00:00.000Z" }), TODAY)).toBe("ENDED");
    expect(isVoucherEnded({ endedAt: undefined })).toBe(false);
  });
  test("`voucherUsable` refuses an ENDED voucher FIRST — hours left and unexpired change nothing; `voucherEligible` (the picker + the SOM) follows", () => {
    expect(voucherUsable(voucher(), TODAY)).toEqual({ ok: true });
    expect(voucherUsable(voucher({ endedAt: new Date() }), TODAY)).toEqual({ ok: false, reason: VOUCHER_ENDED_MESSAGE });
    expect(voucherUsable(voucher({ endedAt: new Date(), usedHours: 10 }), TODAY).reason).toBe(VOUCHER_ENDED_MESSAGE);
    expect(voucherEligible(voucher({ endedAt: new Date() }), TODAY)).toBe(false);
    expect(voucherEligible(voucher(), TODAY)).toBe(true);
    // the ONE gate: the eligible picker and the SOM read `voucherEligible`, which is `voucherUsable(...).ok`
    expect(code(src("src/lib/eligibility.ts"))).toContain("export const voucherEligible = (v: VoucherLike, onDate: string): boolean => voucherUsable(v, onDate).ok;");
    expect(SVC).toContain("voucherEligible(v, date) &&");
    expect(code(src("src/services/som-report.service.ts"))).toContain("voucherEligible(v, today)");
  });
  test("`endableVoucherDraws`: live AND date ≥ today — a past live draw is left, today's is doomed, delivered / cancelled / a COURSE row untouched", () => {
    const rows = [
      draw({ date: shift(-1), status: "PENDING" }), draw({ date: shift(-1), status: "CONFIRMED" }),
      draw({ date: TODAY, status: "CONFIRMED" }), draw({ date: shift(1), status: "PENDING" }), draw({ date: shift(2), status: "CONFIRMED" }), draw({ date: shift(3), status: "EXTENDED" }),
      draw({ date: shift(4), status: "ATTENDED" }), draw({ date: shift(5), status: "CANCELLED" }), draw({ date: shift(6), status: "SICK_LEAVE" }), draw({ date: shift(7), status: "NO_SHOW" }),
      draw({ date: shift(8), status: "CONFIRMED", bookingType: "COURSE_PACKAGE" }),
    ];
    expect(endableVoucherDraws(rows, TODAY).map((r) => [r.date, r.status])).toEqual([[TODAY, "CONFIRMED"], [shift(1), "PENDING"], [shift(2), "CONFIRMED"], [shift(3), "EXTENDED"]]);
  });
  test("`toVoucherDTO` carries `status` + `endedAt` + `endReason`; `remaining` stays readable on an ENDED voucher", () => {
    const at = new Date("2026-09-22T10:00:00.000Z");
    const dto = toVoucherDTO(voucher({ endedAt: at, endReason: "CUSTOMER_CANCELLED", endedBy: "dev" }));
    expect(dto).toMatchObject({ id: V, totalHours: 10, usedHours: 3, remaining: 7, status: "ENDED", endedAt: at, endReason: "CUSTOMER_CANCELLED" });
    expect(dto).not.toHaveProperty("endedBy");
    expect(toVoucherDTO(voucher())).toMatchObject({ status: "ACTIVE", endedAt: null, endReason: null, remaining: 7 });
  });
});

describe("🔴 `endVoucher` by value through a fake tx — the doomed rows, the stamp, the ONE coach notice, no family, `used_hours` never written", () => {
  test("REASON_REQUIRED / INVALID_REASON are 400s BEFORE any tx opens (the course's codes, the course's `allowed`)", async () => {
    const tx = spyOn(db, "transaction").mockImplementation((async () => { throw new Error("tx opened"); }) as any); spies.push(tx);
    await expect(sched.endVoucher(V, { reason: "" })).rejects.toMatchObject({ status: 400, code: "REASON_REQUIRED" });
    await expect(sched.endVoucher(V, { reason: "BORED" })).rejects.toMatchObject({ status: 400, code: "INVALID_REASON", details: { allowed: [...END_REASONS] } });
    expect(tx).not.toHaveBeenCalled();
  });
  test("already ENDED ⇒ 409 ALREADY_ENDED, zero writes", async () => {
    const f = fakeTx(voucher({ endedAt: new Date() }), [draw()]);
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(f.tx)) as any));
    await expect(sched.endVoucher(V, { reason: "CUSTOMER_CANCELLED" }, "dev")).rejects.toMatchObject({ status: 409, code: "ALREADY_ENDED" });
    expect(f.writes).toEqual([]);
  });
  test("the happy path: FUTURE live rows ⇒ CANCELLED + the fixed note + `cancel_reason`, holds reconciled PER ROW, the past row and `used_hours` untouched, the voucher stamped; the result", async () => {
    const past = draw({ date: shift(-2), status: "CONFIRMED" });
    const att = draw({ date: shift(-1), status: "ATTENDED" });
    const p1 = draw({ date: shift(1), status: "PENDING" });
    const c2 = draw({ date: shift(2), status: "CONFIRMED" });
    const c3 = draw({ date: shift(3), status: "CONFIRMED", teacherId: T2, teacher: { id: T2, nickname: "Ple", name: "Ple" } });
    const f = fakeTx(voucher(), [past, att, p1, c2, c3]);
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(f.tx)) as any));
    const out = await sched.endVoucher(V, { reason: "PROGRAM_CHANGED", note: "  ย้ายไปคอร์ส  " }, "dev");
    const cancels = f.writes.filter((w) => w.op === "update" && w.table === "bookings");
    expect(cancels.map((w) => w.patch)).toEqual([p1, c2, c3].map(() => ({ status: "CANCELLED", note: "ยกเลิกวอยเชอร์ (ยกเลิกทั้งใบ)", cancelReason: "PROGRAM_CHANGED" })));
    expect(f.reconciled).toEqual([p1.id, c2.id, c3.id]); // the holds reconcile entered once per doomed row, in order
    const stamps = f.writes.filter((w) => w.op === "update" && w.table === "vouchers");
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.patch).toMatchObject({ endReason: "PROGRAM_CHANGED", endedBy: "dev" });
    expect(stamps[0]!.patch.endedAt).toBeInstanceOf(Date);
    expect(stamps[0]!.patch).not.toHaveProperty("usedHours"); // the balance is frozen, never rewritten
    expect(JSON.stringify(f.writes)).not.toContain("usedHours");
    expect(out).toMatchObject({ cancelled: true, removedSessions: 3 });
    expect(out.voucher).toMatchObject({ id: V, remaining: 7 }); // the DTO, reloaded through the tx
  });
  test("ONE `course_dropped_teacher` per coach for the CONFIRMED draws he loses — `cause: \"voucher_ended\"`, `size` = totalHours, `courseId` = the voucher; a PENDING-only coach gets none; NO family row", async () => {
    const p1 = draw({ date: shift(1), status: "PENDING" });
    const c2 = draw({ date: shift(2), status: "CONFIRMED" });
    const c4 = draw({ date: shift(4), status: "CONFIRMED" });
    const c3 = draw({ date: shift(3), status: "CONFIRMED", teacherId: T2, teacher: { id: T2, nickname: "Ple", name: "Ple" } });
    const pOnly = draw({ date: shift(5), status: "PENDING", teacherId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" });
    const f = fakeTx(voucher(), [p1, c4, c2, c3, pOnly]);
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(f.tx)) as any));
    await sched.endVoucher(V, { reason: "CUSTOMER_CANCELLED" }, "dev");
    const outbox = f.writes.filter((w) => w.op === "insert" && w.table === "outbox").map((w) => w.val);
    expect(outbox).toHaveLength(2);
    expect(outbox.every((o) => o.recipientType === "teacher")).toBe(true);
    const ek = outbox.find((o) => o.recipientLineUserId === "U1")!;
    expect(ek.bookingId).toBe(c2.id); // his FIRST date, sorted
    expect(ek.payload).toEqual({ kind: "course_dropped_teacher", courseId: V, cause: "voucher_ended", size: 10, dates: [shift(2), shift(4)], startTime: "15:00", endTime: "16:00", cancelReason: "CUSTOMER_CANCELLED", note: null });
    expect(outbox.find((o) => o.recipientLineUserId === "U2")!.payload).toMatchObject({ cause: "voucher_ended", dates: [shift(3)] });
    expect(JSON.stringify(f.writes)).not.toContain('"parent"');
    const E = region(SVC, "export async function endVoucher(", "\n}\n");
    expect(E).not.toContain("sendClassCancelledToFamilies");
    expect(E).not.toContain("enqueueParentCopies");
    expect(E).not.toContain("class_cancelled");
  });
  test("🔴 TASK-512 — a CO-TAUGHT voucher ends: EVERY coach gets ONE message with the dates THEY lose — a shared date is in BOTH (correct: each loses that class); no family", async () => {
    const c2 = draw({ date: shift(2), status: "CONFIRMED" }), c3 = draw({ date: shift(3), status: "CONFIRMED", teacherId: T2 }), c4 = draw({ date: shift(4), status: "CONFIRMED" });
    const p5 = draw({ date: shift(5), status: "PENDING" }); // never announced ⇒ nobody, whoever teaches it
    const f = fakeTx(voucher(), [c4, c2, c3, p5]);
    // the coaches of each row, as THE predicate answers them: c2 and c4 co-taught by Ek (primary) + Ple (additional); c3 Ple alone
    spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async (_e: any, id: string) =>
      id === c3.id ? [{ id: T2, lineUserId: "U2" }] : id === p5.id ? [{ id: T1, lineUserId: "U1" }, { id: T2, lineUserId: "U2" }] : [{ id: T1, lineUserId: "U1" }, { id: T2, lineUserId: "U2" }]) as any));
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(f.tx)) as any));
    await sched.endVoucher(V, { reason: "CUSTOMER_CANCELLED" }, "dev");
    const outbox = f.writes.filter((w) => w.op === "insert" && w.table === "outbox").map((w) => w.val);
    expect(outbox.map((o) => [o.recipientType, o.recipientLineUserId, o.bookingId, o.payload.dates])).toEqual([
      ["teacher", "U1", c2.id, [shift(2), shift(4)]], // Ek: the two co-taught classes
      ["teacher", "U2", c2.id, [shift(2), shift(3), shift(4)]], // Ple: the same two AND his own — shift(2) and shift(4) are in BOTH messages, on purpose
    ]);
    expect(outbox.every((o) => o.payload.kind === "course_dropped_teacher" && o.payload.cause === "voucher_ended")).toBe(true);
    expect(JSON.stringify(f.writes)).not.toContain('"parent"');
  });

  test("`previewVoucherEnd`: the course preview's shape + `remaining`; writes nothing; a today row is counted", async () => {
    const rows = [draw({ date: shift(-1), status: "CONFIRMED" }), draw({ date: TODAY, status: "CONFIRMED" }), draw({ date: shift(3), status: "PENDING", teacherId: T2, teacher: { id: T2, nickname: "Ple", name: "Ple" } })];
    spies.push(spyOn(db.query.vouchers, "findFirst").mockImplementation((async () => voucher()) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows) as any));
    const tx = spyOn(db, "transaction").mockImplementation((async () => { throw new Error("tx opened"); }) as any); spies.push(tx);
    expect(await sched.previewVoucherEnd(V)).toEqual({
      alreadyEnded: false,
      removedSessions: 2,
      sessions: [{ date: TODAY, time: "15:00", teacher: "Ek" }, { date: shift(3), time: "15:00", teacher: "Ple" }],
      student: { id: S1, name: "มะขิด", nickname: "ขิด" },
      program: "Freeskate",
      remaining: 7,
    });
    expect(tx).not.toHaveBeenCalled();
    spies[0]!.mockRestore(); spies[0] = spyOn(db.query.vouchers, "findFirst").mockImplementation((async () => voucher({ endedAt: new Date() })) as any);
    expect((await sched.previewVoucherEnd(V)).alreadyEnded).toBe(true);
  });
});

describe("🔴 the creator, the sender, the shared cancel branch, the course end's NEW holds line, the undo — by source", () => {
  test("`prepareVoucherBooking` answers 409 VOUCHER_ENDED BEFORE the first-booking expiry write; the same predicate the gate reads", () => {
    const P = region(SVC, "async function prepareVoucherBooking(", "\n}\n");
    expect(P).toContain('if (isVoucherEnded(v)) throw conflict("VOUCHER_ENDED", VOUCHER_ENDED_MESSAGE);');
    expect(P.indexOf("isVoucherEnded(v)")).toBeLessThan(P.indexOf("const prior = await exec.query.bookings.findFirst("));
    expect(P.indexOf("isVoucherEnded(v)")).toBeLessThan(P.indexOf("await exec.update(vouchers).set({ expiryDate })"));
    expect(code(src("src/lib/voucher.ts"))).toContain("if (isVoucherEnded(v)) return { ok: false, reason: VOUCHER_ENDED_MESSAGE };");
  });
  test("ONE sender, generalised: `{ id, size }` + the third cause; the voucher passes `{ id: voucher.id, size: voucher.totalHours }`", () => {
    const S = region(SVC, "async function sendCourseDroppedToTeachers(", "\n}\n");
    expect(S).toContain('cause: "dropped" | "ended" | "voucher_ended",');
    expect((SVC.match(/async function send\w*Dropped\w*\(/g) ?? []).length).toBe(1);
    expect(region(SVC, "export async function endVoucher(", "\n}\n")).toContain('await sendCourseDroppedToTeachers(tx, { id: voucher.id, size: voucher.totalHours }, doomed, "voucher_ended", { cancelReason: input.reason, note: input.note?.trim() || null });');
  });
  test("🔴 `cancelDoomedRows` is the ONE cancel branch: status + note (+ the code when given) + `reconcileBookingHolds` per row; the course end calls it with NO code (byte parity) — its rows now reconcile holds too", () => {
    const C = region(SVC, "async function cancelDoomedRows(", "\n}\n");
    expect(C).toContain('.set({ status: "CANCELLED", note: stamp.note, ...(stamp.cancelReason ? { cancelReason: stamp.cancelReason } : {}) })');
    expect(C).toContain('await reconcileBookingHolds(tx, b.id, b.teacherId, "CANCELLED", false);');
    const E = region(SVC, "export async function endCourse(", "\n}\n");
    expect(E).toContain('await cancelDoomedRows(tx, doomed, { note: "ยกเลิกคอร์ส (จบคอร์สก่อนกำหนด)", cancelReason: null });');
    expect(E).not.toContain('.set({ status: "CANCELLED"'); // the loop lives in the helper now
    expect(region(SVC, "export async function endVoucher(", "\n}\n")).toContain('await cancelDoomedRows(tx, doomed, { note: "ยกเลิกวอยเชอร์ (ยกเลิกทั้งใบ)", cancelReason: input.reason });');
    // the pause is UNTOUCHED — its own loop, its own note, no reconcile (TASK-198's rule)
    expect(region(SVC, "export async function dropCourse(", "\n}\n")).toContain("status: \"CANCELLED\", note: COURSE_PAUSE_NOTE");
  });
  test("🔴 the course end reconciles holds by VALUE now — one reconcile per doomed row (the pre-existing gap, closed here)", async () => {
    const c1 = draw({ date: shift(1), status: "CONFIRMED", bookingType: "COURSE_PACKAGE", courseId: "k" });
    const c2 = draw({ date: shift(2), status: "PENDING", bookingType: "COURSE_PACKAGE", courseId: "k" });
    const f = fakeTx(null, [c1, c2]);
    const course = { id: "k", size: 10, endedAt: null, droppedAt: null, usedSessions: 0, priorSessions: 0, expiryDate: shift(60), subjectId: "s", studentId: S1, startDate: TODAY, startTime: "15:00:00" };
    f.tx.query.coursePackages = { findFirst: async () => course };
    f.tx.update = ((orig) => (table: any) => (table === bookings ? orig(table) : ({ set: (patch: any) => ({ where: async () => { f.writes.push({ op: "update", table: "course", patch }); } }) })))(f.tx.update);
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(f.tx)) as any));
    const out = await sched.endCourse("k", { reason: "ADMIN_ERROR" }, "dev");
    expect(out.removedSessions).toBe(2);
    expect(f.reconciled).toEqual([c1.id, c2.id]);
    expect(f.writes.filter((w) => w.table === "bookings").map((w) => w.patch)).toEqual([{ status: "CANCELLED", note: "ยกเลิกคอร์ส (จบคอร์สก่อนกำหนด)" }, { status: "CANCELLED", note: "ยกเลิกคอร์ส (จบคอร์สก่อนกำหนด)" }]); // no `cancelReason` — byte parity
  });
  test("the undo of a PAST draw on an ENDED voucher stays open: the status cancel's voucher return has no `endedAt` guard — the end freezes the future, not history", () => {
    const U = region(SVC, "export async function updateBookingStatus(", "\n}\n");
    expect(U).toContain("if (current.voucherId && current.voucher) {");
    expect(U).toContain(".set({ usedHours: sql`GREATEST(${vouchers.usedHours} - 1, 0)` })"); // 🔻 TASK-496: was `afterReturn(…)` (read-modify-write)
    expect(U).not.toContain("isVoucherEnded");
    expect(U).not.toContain("VOUCHER_ENDED");
  });
});

describe("🔴 the routes under the course-cancel key; the validators reused; the renderer byte-identical to an END", () => {
  test("`POST /vouchers/:id/cancel` + `/preview` = `action:bookings.course-cancel` on `menu:bookings` — the same object the course routes carry; no new key", () => {
    expect(ROUTE_ACCESS["POST /vouchers/:id/cancel"]).toEqual(ROUTE_ACCESS["POST /courses/:id/cancel"]);
    expect(ROUTE_ACCESS["POST /vouchers/:id/cancel/preview"]).toEqual(ROUTE_ACCESS["POST /courses/:id/cancel/preview"]);
    expect(ROUTE_ACCESS["POST /vouchers/:id/cancel"]).toMatchObject({ action: "action:bookings.course-cancel" });
    const A = code(src("src/routes/api.ts"));
    expect(A).toContain('.post("/vouchers/:id/cancel/preview", zValidator("json", v.endCoursePreview), async (c) =>');
    expect(A).toContain('.post("/vouchers/:id/cancel", zValidator("json", v.endCourse), async (c) =>');
    expect(A).toContain('c.json(await svc.endVoucher(c.req.param("id"), c.req.valid("json"), actorOf(c))),');
  });
  test("through the ROOT app: the preview and the cancel reach their services (spied); a bodiless cancel is the validator's 400", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    spies.push(spyOn(sched, "previewVoucherEnd").mockImplementation((async (id: string) => { calls.push(["preview", id]); return { alreadyEnded: false, removedSessions: 1, sessions: [], student: null, program: "Freeskate", remaining: 7 }; }) as any));
    spies.push(spyOn(sched, "endVoucher").mockImplementation((async (...a: any[]) => { calls.push(["end", ...a]); return { cancelled: true, removedSessions: 1, voucher: { id: V } }; }) as any));
    const pv = await json("POST", `/vouchers/${V}/cancel/preview`, {});
    expect(pv.status).toBe(200);
    expect(await pv.json()).toMatchObject({ removedSessions: 1, remaining: 7 });
    const end = await json("POST", `/vouchers/${V}/cancel`, { reason: "CUSTOMER_CANCELLED", note: "x" });
    expect(end.status).toBe(200);
    expect(calls).toEqual([["preview", V], ["end", V, { reason: "CUSTOMER_CANCELLED", note: "x" }, "dev"]]);
    expect((await json("POST", `/vouchers/${V}/cancel`, {})).status).toBe(400);
  });
  test("the coach's message for `voucher_ended` is BYTE-IDENTICAL to an `ended` one — the END title, `Freeskate 10 HR`, no new bytes anywhere", () => {
    const ctx = { studentName: "มะขิด", subject: "Freeskate", coach: "Ek" } as any;
    const render = (cause: string, lang: "TH" | "EN") => formatOutboxMessage({ kind: "course_dropped_teacher", cause, size: 10, dates: ["2026-10-05", "2026-10-12"], startTime: "15:00", endTime: "16:00", cancelReason: "CUSTOMER_CANCELLED", note: null } as any, ctx, lang, "teacher");
    for (const lang of ["TH", "EN"] as const) {
      const msg = render("voucher_ended", lang);
      expect(msg).toBe(render("ended", lang));
      expect(msg).not.toBe(render("dropped", lang));
      expect(msg).toContain("COURSE ENDED / ยกเลิกคอร์ส ‼️");
      expect(msg).toContain("Freeskate 10 HR");
      expect(msg).toContain("05-10-2026, 12-10-2026");
      expect(msg.toLowerCase()).not.toContain("voucher");
    }
    expect(code(src("src/lib/line-message.ts"))).toContain('const title = payload.cause === "ended" || payload.cause === "voucher_ended" ? "ob_course_ended_title" : "ob_course_dropped_title";');
  });
});
