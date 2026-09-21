// TASK-428 (`REQ-101`, SPEC-088 Part A) — the OTHER SERIES Manage-plan: migration `0049` (the key column + the partial index
// as witness; 50 = 50), the creator mints ONE key and stamps every row (`201 { seriesKey, … }`), the reads by key, the
// doors by VALUE through fake txs (confirm-all = the bulk-confirm loop; cancel-all one tx + ONE summary notice per teacher
// and NO per-row notice; add / remove / swap from a date on through ONE `seriesRowsFrom`, the first clash rolls back, the
// primary refused, `ALREADY_ON_ROW` both ways; add dates copies the template; the header PATCH on every live row, no
// `startTime`), key 58 on cancel-all, the three kinds by value (ADDED/REMOVED = the owner-accepted bytes, `DD-MM-YYYY`;
// CANCELLED a placeholder), the backfill by value on a fixture, nothing on GROUP/CAMP.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApiException } from "./http";
import { formatOutboxMessage } from "./line-message";
import { ACTION_KEYS, ACTION_REGISTRY } from "./permissions";
import { ROUTE_ACCESS, TEACHER_ALLOWED } from "./route-access";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import * as v from "../validation";
import * as sched from "../services/scheduler.service";
import * as series from "../services/other-series.service";
import * as lineLib from "./line";
import { groupForBackfill, describeGroup } from "../../scripts/backfill-other-series";
import { db } from "../db";
import { bookingTeachers, bookings } from "../db/schema";
import { toBookingDTO } from "../db/mappers";
import { readSrc } from "./read-src";

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
const SVC = code(src("src/services/other-series.service.ts"));
const K = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", T2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", T3 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });

const row = (over: any = {}) => ({ id: `b-${over.date ?? "x"}`, date: "2026-10-05", startTime: "15:00:00", endTime: "16:00:00", status: "PENDING", bookingType: "OTHER", teacherId: T1, otherTitle: "ECA Club", otherKind: "ECA", headCount: 12, note: null, teacherRateMinor: 50000, otherSeriesKey: K, additionalTeachers: [{ teacherId: T2, rateMinor: 40000, teacher: { id: T2, nickname: "Nok", name: "Nok", lineUserId: "U2" } }], teacher: { id: T1, nickname: "Bank", name: "Bank", lineUserId: "U1" }, ...over });
/** A fake tx over an in-memory series: records every write; the reads answer from `rows`. */
const fakeTx = (rows: any[], opts: { clashOn?: string } = {}) => {
  const writes: any[] = [];
  const tx: any = {
    query: {
      bookings: {
        findMany: async ({ where }: any) => {
          // both the series read (key) and the clash check (teacherId/date/startTime) come through here
          const probe: string[] = []; try { where({ otherSeriesKey: "k", bookingType: "t", teacherId: "tid", date: "d", startTime: "s", id: "id" }, { and: (...a: any[]) => a, eq: (c: any, val: any) => { probe.push(String(c)); return val; }, inArray: () => null, ne: () => null, notInArray: () => null, gte: () => null, lte: () => null, or: () => null, isNull: () => null }); } catch {}
          return probe.includes("k") ? rows : [];
        },
        findFirst: async ({ where }: any) => {
          const probe: any[] = []; try { where({ teacherId: "tid", date: "d", startTime: "s", id: "id" }, { and: (...a: any[]) => a, eq: (c: any, val: any) => { probe.push([String(c), val]); return val; }, ne: () => null, notInArray: () => null, inArray: () => null, or: () => null }); } catch {}
          const d = probe.find((p) => p[0] === "d")?.[1];
          if (opts.clashOn && d === opts.clashOn) return { id: "other", otherTitle: "Camp", student: null, startTime: "15:00:00", endTime: "16:00:00", teacher: { nickname: "Ple", name: "Ple" } };
          return rows.find((r) => r.id === probe.find((p) => p[0] === "id")?.[1]) ?? null;
        },
      },
      teachers: { findFirst: async () => ({ id: T3, nickname: "Ple", name: "Ple", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME", lineUserId: "U3" }), findMany: async ({ where }: any) => { const ids: string[] = []; where({ id: "id" }, { inArray: (_: any, v: string[]) => { ids.push(...v); return null; } }); return [{ id: T1, lineUserId: "U1" }, { id: T2, lineUserId: "U2" }, { id: T3, lineUserId: "U3" }].filter((t) => ids.includes(t.id)); } },
      boItem: { findMany: async () => [] },
      appSettings: { findMany: async () => [], findFirst: async () => null },
    },
    insert: (table: any) => ({ values: (val: any) => { const rec = { op: "insert", table: table === bookingTeachers ? "bookingTeachers" : table === bookings ? "bookings" : "other", val }; writes.push(rec); const ret = { returning: async () => [{ id: `new-${val.date ?? writes.length}` }], onConflictDoNothing: async () => {} }; return Object.assign(Promise.resolve(), ret); } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: async (w: any) => { writes.push({ op: "update", table: table === bookings ? "bookings" : table === bookingTeachers ? "bookingTeachers" : "other", patch, where: String(w) }); } }) }),
    delete: (table: any) => ({ where: async () => { writes.push({ op: "delete", table: table === bookingTeachers ? "bookingTeachers" : "other" }); } }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
  return { tx, writes };
};

describe("🔴 the migration — 0049, counted, ONE nullable column + the partial index LAST = the witness; the SHARE lock named; the schema + DTO", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
  const sql = readFileSync(resolve(root, "drizzle/0049_other_series_key.sql"), "utf8").replace(/\r\n/g, "\n");
  test("50 = 50: `0049_other_series_key` is the 50th file, idx 49, the last; 'expects 50'", () => {
    expect(files.length).toBe(50);
    expect(journal.entries.length).toBe(50);
    expect(files[49]).toBe("0049_other_series_key.sql");
    expect(journal.entries[49]).toMatchObject({ idx: 49, tag: "0049_other_series_key" });
    expect(sql).toContain("`db:verify` expects 50");
    const stmts = sql.split("--> statement-breakpoint").map((s) => s.replace(/^--.*$/gm, "").trim()).filter(Boolean);
    expect(stmts).toEqual([
      'ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "other_series_key" uuid NULL;',
      'CREATE INDEX IF NOT EXISTS "bookings_other_series_idx" ON "bookings" ("other_series_key") WHERE "other_series_key" IS NOT NULL;',
    ]);
    expect(sql).toContain("SHARE lock for its one scan");
    const last = SCHEDULING_WITNESSES[SCHEDULING_WITNESSES.length - 1]!;
    expect(last).toMatchObject({ tag: "0049_other_series_key", probe: { kind: "index", index: "bookings_other_series_idx" }, rerunnable: true });
    expect(code(src("src/db/schema.ts"))).toContain('otherSeriesKey: uuid("other_series_key"),');
    expect((toBookingDTO({ id: "b", date: "2026-10-05", startTime: "15:00:00", endTime: "16:00:00", bookingType: "OTHER", status: "PENDING", otherTitle: "ECA", teacher: { id: T1, name: "Bank", nickname: "Bank" }, badges: [], additionalTeachers: [], otherSeriesKey: K }) as any).otherSeriesKey).toBe(K);
  });
  test("the creator mints ONE key, stamps every row through the ONE inserter, returns it (source)", () => {
    const SCHED = code(src("src/services/scheduler.service.ts"));
    const C = region(SCHED, "export async function createOtherSeries(", "\n}\n");
    expect(C).toContain("const seriesKey = crypto.randomUUID();");
    expect(C).toContain('bookingType: "OTHER", otherTitle: input.title, date, otherSeriesKey: seriesKey });');
    expect(C).toContain("return { seriesKey, created: bookingIds.length, bookingIds };");
    expect(region(SCHED, "export async function insertBooking(", "\n}\n")).toContain("otherSeriesKey: input.otherSeriesKey ?? null,");
  });
});

describe("🔑 key 58, the access rows, the validators, the routes through the ROOT app", () => {
  test("58 keys; `action:calendar.other-cancel-all` labelled; the nine rows; none in TEACHER_ALLOWED; add-dates is the creator's key", () => {
    expect(ACTION_KEYS.length).toBe(59); // 🔻 TASK-431: + bookings.coach-rate
    expect(ACTION_REGISTRY.find((a) => a.key === "action:calendar.other-cancel-all")).toMatchObject({ labelTh: "ยกเลิกตารางอื่นๆ ทั้งชุด", labelEn: "Cancel a whole Other series" });
    expect(ROUTE_ACCESS["GET /other-series"]).toEqual({ menus: ["menu:calendar"] });
    expect(ROUTE_ACCESS["GET /other-series/:key"]).toEqual({ menus: ["menu:calendar"] });
    expect(ROUTE_ACCESS["POST /other-series/:key/confirm-all"]!.action).toBe("action:calendar.status");
    expect(ROUTE_ACCESS["POST /other-series/:key/cancel-all"]!.action).toBe("action:calendar.other-cancel-all");
    for (const r of ["POST /other-series/:key/teachers", "DELETE /other-series/:key/teachers/:teacherId", "PATCH /other-series/:key/teacher", "PATCH /other-series/:key"]) expect(ROUTE_ACCESS[r]!.action).toBe("action:calendar.booking-edit");
    expect(ROUTE_ACCESS["POST /other-series/:key/dates"]!.action).toBe("action:calendar.other-series");
    expect([...TEACHER_ALLOWED].filter((r) => r.includes("other-series"))).toEqual([]);
  });
  test("the validators: cancel-all's closed reason; `fromDate` optional; the swap refuses the same teacher; dates unique; the header PATCH has no `startTime` and needs ≥ 1 field", () => {
    expect(v.otherSeriesCancelAll.safeParse({ reasonCode: "ADMIN_ERROR" }).success).toBe(true);
    expect(v.otherSeriesCancelAll.safeParse({ reasonCode: "WHATEVER" }).success).toBe(false);
    expect(v.otherSeriesAddTeacher.safeParse({ teacherId: T2 }).success).toBe(true);
    expect(v.otherSeriesAddTeacher.safeParse({ teacherId: T2, rateMinor: 40000, fromDate: "2026-10-12" }).success).toBe(true);
    expect(v.otherSeriesSwap.safeParse({ from: T1, to: T1 }).success).toBe(false);
    expect(v.otherSeriesSwap.safeParse({ from: T1, to: T3 }).success).toBe(true);
    expect(v.otherSeriesDates.safeParse({ dates: ["2026-10-12", "2026-10-12"] }).success).toBe(false);
    expect(v.otherSeriesPatch.safeParse({}).success).toBe(false);
    expect(v.otherSeriesPatch.safeParse({ startTime: "16:00" } as any).success).toBe(false);
    expect(v.otherSeriesPatch.safeParse({ title: "Chess Club", headCount: 10 }).success).toBe(true);
    expect(v.otherSeriesQuery.safeParse({ from: "2026-10-31", to: "2026-10-01" }).success).toBe(false);
  });
  test("the routes reach their services (spied); the create answers 201 with the key", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const spy = (name: keyof typeof series, ret: any) => spies.push(spyOn(series, name).mockImplementation((async (...a: any[]) => { calls.push([name, ...a]); return ret; }) as any));
    spy("listOtherSeries", []); spy("getOtherSeries", { key: K }); spy("confirmAllOtherSeries", { confirmed: 1 }); spy("cancelAllOtherSeries", { cancelled: 2 });
    spy("addTeacherToOtherSeries", { added: 2 }); spy("removeTeacherFromOtherSeries", { removed: 1 }); spy("swapOtherSeriesTeacher", { moved: 2 }); spy("addDatesToOtherSeries", { created: 1, bookingIds: ["x"] }); spy("updateOtherSeries", { updated: 3 });
    spies.push(spyOn(sched, "createOtherSeries").mockImplementation((async () => ({ seriesKey: K, created: 2, bookingIds: ["a", "b"] })) as any));
    const create = await json("POST", "/bookings/other-series", { title: "ECA Club", otherKind: "ECA", headCount: 12, teacherId: T1, startTime: "15:00", dates: ["2026-10-05", "2026-10-12"] });
    expect(create.status).toBe(201);
    expect(await create.json()).toEqual({ seriesKey: K, created: 2, bookingIds: ["a", "b"] });
    expect((await json("GET", "/other-series?from=2026-10-01&to=2026-10-31")).status).toBe(200);
    expect((await json("GET", `/other-series/${K}`)).status).toBe(200);
    expect((await json("POST", `/other-series/${K}/confirm-all`)).status).toBe(200);
    expect((await json("POST", `/other-series/${K}/cancel-all`, { reasonCode: "ADMIN_ERROR" })).status).toBe(200);
    expect((await json("POST", `/other-series/${K}/teachers`, { teacherId: T3 })).status).toBe(201);
    expect((await json("DELETE", `/other-series/${K}/teachers/${T2}?fromDate=2026-10-12`)).status).toBe(200);
    expect((await json("PATCH", `/other-series/${K}/teacher`, { from: T1, to: T3 })).status).toBe(200);
    expect((await json("POST", `/other-series/${K}/dates`, { dates: ["2026-10-19"] })).status).toBe(201);
    expect((await json("PATCH", `/other-series/${K}`, { title: "Chess Club" })).status).toBe(200);
    expect(calls.map((c) => c[0])).toEqual(["listOtherSeries", "getOtherSeries", "confirmAllOtherSeries", "cancelAllOtherSeries", "addTeacherToOtherSeries", "removeTeacherFromOtherSeries", "swapOtherSeriesTeacher", "addDatesToOtherSeries", "updateOtherSeries"]);
    expect(calls[3]!.slice(1)).toEqual([K, { reasonCode: "ADMIN_ERROR" }, "dev"]); // the actor rides
    expect(calls[5]!.slice(1)).toEqual([K, T2, { fromDate: "2026-10-12" }]);
  });
});

describe("🔴 the reads by VALUE — the header from the first LIVE row, every row in date order; the range list", () => {
  test("`getOtherSeries`: header facts, extras + rates, rows", async () => {
    const rows = [row({ id: "b1", date: "2026-10-05", status: "CANCELLED", otherTitle: "Old name" }), row({ id: "b2", date: "2026-10-12" }), row({ id: "b3", date: "2026-10-19", status: "CONFIRMED" })];
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows) as any));
    const d = await series.getOtherSeries(K);
    expect(d).toMatchObject({ key: K, title: "ECA Club", kind: "ECA", headCount: 12, startTime: "15:00", teacherId: T1, additionalTeacherIds: [T2], teacherRates: { [T1]: 50000, [T2]: 40000 } });
    expect(d.rows.map((r) => [r.bookingId, r.status])).toEqual([["b1", "CANCELLED"], ["b2", "PENDING"], ["b3", "CONFIRMED"]]);
    spies[0]!.mockRestore(); spies[0] = spyOn(db.query.bookings, "findMany").mockImplementation((async () => []) as any);
    await expect(series.getOtherSeries("nope")).rejects.toMatchObject({ status: 404 });
  });
  test("`seriesRowsFrom` — live rows from the date on (the owner's ruling 2: the past is history)", () => {
    const rows = [row({ date: "2026-10-05", status: "ATTENDED" }), row({ date: "2026-10-12", status: "CANCELLED" }), row({ date: "2026-10-19" }), row({ date: "2026-10-26", status: "CONFIRMED" })] as any[];
    expect(series.seriesRowsFrom(rows, "2026-10-12").map((r) => r.date)).toEqual(["2026-10-19", "2026-10-26"]);
    expect(series.seriesRowsFrom(rows, "2026-10-26").map((r) => r.date)).toEqual(["2026-10-26"]);
    expect(series.seriesRowsFrom(rows, "2027-01-01")).toEqual([]);
    expect((SVC.match(/seriesRowsFrom\(rows, input\.fromDate \?\? today\(\)\)/g) ?? []).length).toBe(3); // add · remove · swap, the ONE reader
  });
});

describe("🔴 the doors by VALUE through a fake tx — one tx; the first clash rolls back; from today; the primary refused; ONE notice per teacher", () => {
  const rows = () => [row({ id: "b1", date: "2026-10-05", status: "ATTENDED" }), row({ id: "b2", date: "2026-10-12", status: "CONFIRMED" }), row({ id: "b3", date: "2026-10-19" })];
  test("cancel-all: every LIVE row ⇒ CANCELLED + the reason, ATTENDED untouched, holds reconciled; ONE `other_series_cancelled` per teacher (both coaches), NO per-row notice", async () => {
    const { tx, writes } = fakeTx(rows());
    const notices: any[] = [];
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { notices.push(o); return { status: "queued" } as any; }) as any));
    spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async (...a: any[]) => { writes.push({ op: "holds", a: a.slice(1) }); }) as any));
    const out = await series.cancelAllOtherSeries(K, { reasonCode: "ADMIN_ERROR", note: "wrong entry" }, "dev");
    expect(out).toEqual({ cancelled: 2 });
    expect(writes.filter((w) => w.op === "update").map((w) => w.patch)).toEqual([{ status: "CANCELLED", cancelReason: "ADMIN_ERROR", note: "wrong entry" }, { status: "CANCELLED", cancelReason: "ADMIN_ERROR", note: "wrong entry" }]);
    expect(writes.filter((w) => w.op === "holds").map((w) => w.a)).toEqual([["b2", T1, "CANCELLED", false], ["b3", T1, "CANCELLED", false]]);
    expect(notices).toHaveLength(2); // one per teacher across the LIVE rows (primary + extra), never per row
    expect(notices.map((n) => [n.recipientType, n.recipientLineUserId, n.bookingId ?? null])).toEqual([["teacher", "U1", null], ["teacher", "U2", null]]);
    // 🔻 TASK-430 — a mixed PENDING + CONFIRMED series: EVERY cancelled date in the one message (b2 CONFIRMED, b3 PENDING)
    expect(notices[0]!.payload).toMatchObject({ kind: "other_series_cancelled", title: "ECA Club", startTime: "15:00", endTime: "16:00", dates: ["2026-10-12", "2026-10-19"], reason: "ADMIN_ERROR" });
    expect(notices.some((n) => n.payload.kind === "class_cancelled_teacher")).toBe(false);
    await expect(series.cancelAllOtherSeries(K, { reasonCode: "NOPE" }, "dev")).rejects.toMatchObject({ status: 400 });
  });
  test("🔻 TASK-430 — a PENDING-only series (Tanya's): cancel-all enqueues ONE `other_series_cancelled` per coach listing ALL the dates (the CONFIRMED-only gate is gone; the per-row cancel keeps it)", async () => {
    const pendingOnly = [row({ id: "p1", date: "2026-10-05" }), row({ id: "p2", date: "2026-10-12" }), row({ id: "p3", date: "2026-10-19" })];
    const { tx } = fakeTx(pendingOnly);
    const notices: any[] = [];
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { notices.push(o); return { status: "queued" } as any; }) as any));
    spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
    expect(await series.cancelAllOtherSeries(K, { reasonCode: "ADMIN_ERROR" }, "dev")).toEqual({ cancelled: 3 });
    expect(notices.map((n) => n.recipientLineUserId)).toEqual(["U1", "U2"]);
    for (const n of notices) expect(n.payload).toMatchObject({ kind: "other_series_cancelled", dates: ["2026-10-05", "2026-10-12", "2026-10-19"], reason: "ADMIN_ERROR" });
    expect(region(SVC, "export async function cancelAllOtherSeries(", "\n}\n")).toContain('await notifySeriesTeachers(tx, "other_series_cancelled", t, live, { reason: input.reasonCode, actor });');
    // the per-row cancel's CONFIRMED-only rule is untouched (by source): a PENDING row's cancel tells no coach
    const SCHED = code(src("src/services/scheduler.service.ts"));
    expect(region(SCHED, "async function sendClassCancelledToTeacher(", "\n}\n")).toContain('if (current.status !== "CONFIRMED") return');
  });
  test("add teacher: from today (the ATTENDED row skipped, the two future rows joined), ONE `other_teacher_added`; the primary / an existing extra ⇒ 409 ALREADY_ON_ROW; a clash ⇒ 409 SLOT_TAKEN naming the date, nothing kept", async () => {
    const { tx, writes } = fakeTx(rows());
    const notices: any[] = [];
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { notices.push(o); return { status: "queued" } as any; }) as any));
    const out = await series.addTeacherToOtherSeries(K, { teacherId: T3, rateMinor: 30000, fromDate: "2026-10-06" });
    expect(out).toEqual({ added: 2 });
    expect(writes.filter((w) => w.op === "insert" && w.table === "bookingTeachers").map((w) => w.val)).toEqual([[{ bookingId: "b2", teacherId: T3, rateMinor: 30000 }], [{ bookingId: "b3", teacherId: T3, rateMinor: 30000 }]]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!).toMatchObject({ recipientType: "teacher", recipientLineUserId: "U3", payload: { kind: "other_teacher_added", title: "ECA Club", otherKind: "ECA", startTime: "15:00", dates: ["2026-10-12", "2026-10-19"] } });
    await expect(series.addTeacherToOtherSeries(K, { teacherId: T1, fromDate: "2026-10-06" })).rejects.toMatchObject({ code: "ALREADY_ON_ROW" });
    await expect(series.addTeacherToOtherSeries(K, { teacherId: T2, fromDate: "2026-10-06" })).rejects.toMatchObject({ code: "ALREADY_ON_ROW" });
    // a clash on the SECOND row: the error names the date; the tx (the caller's) rolls back — the first row's insert is inside it
    const clash = fakeTx(rows(), { clashOn: "2026-10-19" });
    spies[0]!.mockRestore(); spies[0] = spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(clash.tx)) as any);
    const e = await series.addTeacherToOtherSeries(K, { teacherId: T3, fromDate: "2026-10-06" }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiException);
    expect(e.code).toBe("SLOT_TAKEN");
    expect(e.message).toContain("2026-10-19 15:00");
    expect(e.message).toContain("ไม่ได้บันทึกอะไร");
  });
  test("remove teacher: the extra's rows from the date on deleted, ONE `other_teacher_removed`; the primary ⇒ 409 PRIMARY_TEACHER", async () => {
    const { tx, writes } = fakeTx(rows());
    const notices: any[] = [];
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { notices.push(o); return { status: "queued" } as any; }) as any));
    expect(await series.removeTeacherFromOtherSeries(K, T2, { fromDate: "2026-10-13" })).toEqual({ removed: 1 });
    expect(writes.filter((w) => w.op === "delete")).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]!).toMatchObject({ recipientLineUserId: "U2", payload: { kind: "other_teacher_removed", dates: ["2026-10-19"] } });
    await expect(series.removeTeacherFromOtherSeries(K, T1, { fromDate: "2026-10-13" })).rejects.toMatchObject({ code: "PRIMARY_TEACHER" });
    expect(await series.removeTeacherFromOtherSeries(K, T3, { fromDate: "2026-10-13" })).toEqual({ removed: 0 }); // not on the rows: nothing, no notice
    expect(notices).toHaveLength(1);
  });
  test("swap the primary from the date on: each row re-teachered + holds reconciled + `teacher_unassigned`/`teacher_assigned` per row; `from` must be the primary; `to` an extra ⇒ ALREADY_ON_ROW", async () => {
    const { tx, writes } = fakeTx(rows());
    const notices: any[] = [];
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { notices.push(o); return { status: "queued" } as any; }) as any));
    spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async (...a: any[]) => { writes.push({ op: "holds", a: a.slice(1) }); }) as any));
    expect(await series.swapOtherSeriesTeacher(K, { from: T1, to: T3, fromDate: "2026-10-06" })).toEqual({ moved: 2 });
    expect(writes.filter((w) => w.op === "update").map((w) => w.patch)).toEqual([{ teacherId: T3 }, { teacherId: T3 }]);
    expect(writes.filter((w) => w.op === "holds").map((w) => w.a)).toEqual([["b2", T3, "CONFIRMED", false], ["b3", T3, "PENDING", false]]);
    expect(notices.map((n) => [n.payload.kind, n.bookingId])).toEqual([["teacher_unassigned", "b2"], ["teacher_assigned", "b2"], ["teacher_unassigned", "b3"], ["teacher_assigned", "b3"]]);
    await expect(series.swapOtherSeriesTeacher(K, { from: T2, to: T3, fromDate: "2026-10-06" })).rejects.toMatchObject({ status: 400 });
    await expect(series.swapOtherSeriesTeacher(K, { from: T1, to: T2, fromDate: "2026-10-06" })).rejects.toMatchObject({ code: "ALREADY_ON_ROW" });
  });
  test("add dates: the template's facts + extras + rates copied through the ONE inserter, the key stamped; an existing live date ⇒ 409 DATE_EXISTS", async () => {
    const { tx } = fakeTx(rows());
    const inserted: any[] = [];
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    spies.push(spyOn(sched, "insertBooking").mockImplementation((async (_e: any, sid: any, input: any) => { inserted.push([sid, input]); return `new-${input.date}`; }) as any));
    spies.push(spyOn(sched, "attachAdditionalTeachers").mockImplementation((async (_e: any, id: string, ids: string[], rates: any) => { inserted.push(["extras", id, ids, rates]); }) as any));
    const out = await series.addDatesToOtherSeries(K, { dates: ["2026-11-02", "2026-10-26"] });
    expect(out).toEqual({ created: 2, bookingIds: ["new-2026-10-26", "new-2026-11-02"] }); // sorted
    expect(inserted[0]).toEqual([null, { teacherId: T1, subjectId: null, date: "2026-10-26", startTime: "15:00", bookingType: "OTHER", otherTitle: "ECA Club", otherKind: "ECA", headCount: 12, note: null, teacherRates: { [T1]: 50000, [T2]: 40000 }, otherSeriesKey: K }]);
    expect(inserted[1]).toEqual(["extras", "new-2026-10-26", [T2], { [T1]: 50000, [T2]: 40000 }]);
    await expect(series.addDatesToOtherSeries(K, { dates: ["2026-10-12"] })).rejects.toMatchObject({ code: "DATE_EXISTS" });
  });
  test("the header PATCH: title / kind / heads / the primary's rate on every LIVE row (the ATTENDED row untouched), the extras' rates on their rows; a stray rate ⇒ 400", async () => {
    const { tx, writes } = fakeTx(rows());
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    expect(await series.updateOtherSeries(K, { title: "Chess Club", headCount: 10, teacherRates: { [T1]: 55000, [T2]: 45000 } })).toEqual({ updated: 2 });
    expect(writes.filter((w) => w.table === "bookings").map((w) => w.patch)).toEqual([{ otherTitle: "Chess Club", headCount: 10, teacherRateMinor: 55000 }, { otherTitle: "Chess Club", headCount: 10, teacherRateMinor: 55000 }]);
    expect(writes.filter((w) => w.table === "bookingTeachers").map((w) => w.patch)).toEqual([{ rateMinor: 45000 }, { rateMinor: 45000 }]);
    await expect(series.updateOtherSeries(K, { teacherRates: { [T3]: 1 } })).rejects.toMatchObject({ status: 400 });
    expect(SVC).not.toMatch(/startTime: input|patch\.startTime/);
  });
  test("confirm-all = the bulk-confirm loop over the key's PENDING rows (source + value through a spied loop)", async () => {
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows()) as any));
    spies.push(spyOn(sched, "bulkConfirm").mockImplementation((async (ids: string[]) => ({ results: ids.map((id) => ({ id, outcome: "confirmed" })) })) as any));
    expect(await series.confirmAllOtherSeries(K)).toEqual({ confirmed: 1, skipped: 0, results: [{ id: "b3", outcome: "confirmed" }] });
    expect(region(SVC, "export async function confirmAllOtherSeries(", "\n}\n")).toContain('await bulkConfirm(rows.filter((r) => r.status === "PENDING").map((r) => r.id));');
  });
  test("🚫 nothing on GROUP / CAMP: the series file never writes groupKey / groupId / campWeekDayId, never posts money", () => {
    expect(SVC).not.toMatch(/groupKey|groupId|campWeekDayId|recordSale|recordRental|ratePostedAt/);
    expect(SVC).toContain('a(e(b.otherSeriesKey, key), e(b.bookingType, "OTHER"))'); // the ONE read, OTHER rows only
  });
});

describe("🔴 the three kinds by VALUE — ADDED / REMOVED are the owner-accepted bytes, CANCELLED a placeholder; `DD-MM-YYYY`, one line per date", () => {
  const payload = (kind: string, extra: any = {}) => ({ kind, title: "ECA Club", otherKind: "ECA", startTime: "15:00", endTime: "16:00", dates: ["2026-10-12", "2026-10-19"], ...extra });
  test("ADDED (TH + EN)", () => {
    const th = formatOutboxMessage(payload("other_teacher_added") as any, {}, "TH", "teacher");
    expect(th).toBe("📅 เพิ่มตารางสอน\nคุณถูกเพิ่มเข้าตารางสอน\nรายการ: ECA Club\nTime: 15:00-16:00\nวันที่:\n  - 12-10-2026\n  - 19-10-2026\nกรุณาตรวจสอบตารางของคุณ");
    const en = formatOutboxMessage(payload("other_teacher_added") as any, {}, "EN", "teacher");
    expect(en).toBe("📅 ADDED TO SCHEDULE\nYou have been added to a schedule\nItem: ECA Club\nTime: 15:00-16:00\nDates:\n  - 12-10-2026\n  - 19-10-2026\nPlease check your schedule");
  });
  test("REMOVED (TH + EN)", () => {
    expect(formatOutboxMessage(payload("other_teacher_removed") as any, {}, "TH", "teacher")).toBe("❌ นำออกจากตารางสอน\nคุณถูกนำออกจากตารางสอน\nรายการ: ECA Club\nTime: 15:00-16:00\nวันที่:\n  - 12-10-2026\n  - 19-10-2026");
    expect(formatOutboxMessage(payload("other_teacher_removed") as any, {}, "EN", "teacher")).toBe("❌ REMOVED FROM SCHEDULE\nYou have been removed from a schedule\nItem: ECA Club\nTime: 15:00-16:00\nDates:\n  - 12-10-2026\n  - 19-10-2026");
  });
  test("CANCELLED (🔻 TASK-430: REQ-101 §5's owner-accepted bytes, NO placeholder) — TH + EN, the reason's existing label, `DD-MM-YYYY`; an empty payload leaks nothing", () => {
    expect(formatOutboxMessage(payload("other_series_cancelled", { reason: "ADMIN_ERROR" }) as any, {}, "TH", "teacher")).toBe("❌ ยกเลิกตารางทั้งชุด\nตารางสอนถูกยกเลิกทั้งชุด\nรายการ: ECA Club\nTime: 15:00-16:00\nเหตุผล: จองผิด (แอดมิน)\nวันที่:\n  - 12-10-2026\n  - 19-10-2026");
    expect(formatOutboxMessage(payload("other_series_cancelled", { reason: "ADMIN_ERROR" }) as any, {}, "EN", "teacher")).toBe("❌ SCHEDULE CANCELLED\nYour teaching schedule has been cancelled\nProgram: ECA Club\nTime: 15:00-16:00\nReason: Booking error (admin)\nDate:\n  - 12-10-2026\n  - 19-10-2026");
    expect(formatOutboxMessage({ kind: "other_series_cancelled" } as any, {}, "TH", "teacher")).toBe("❌ ยกเลิกตารางทั้งชุด\nตารางสอนถูกยกเลิกทั้งชุด");
    const I = readFileSync(resolve(root, "src/lib/line-i18n.ts"), "utf8");
    expect(region(I, "os_added_title", "ob_teacher_assigned_title")).not.toContain("📖"); // the three kinds carry no placeholder mark
    expect(I).toContain("ADDED / REMOVED: Porter's draft, OWNER-ACCEPTED 2026-09-21");
    expect(I).toContain("CANCELLED (TASK-430, REQ-101 §5): Porter's draft, OWNER-ACCEPTED 2026-09-21");
  });
});

describe("🔴 the backfill by VALUE on a fixture — (title · kind · start · teacher) ⇒ one key each; CAMP and keyed rows never reach it; `--dry-run` writes nothing", () => {
  test("three groups ⇒ three keys; two coaches with the same title ⇒ two keys; date order inside", () => {
    let n = 0;
    const mint = () => `key-${++n}`;
    const rows = [
      { id: "1", date: "2026-10-12", startTime: "15:00:00", teacherId: T1, otherTitle: "ECA Club", otherKind: "ECA", nickname: "Bank" },
      { id: "2", date: "2026-10-05", startTime: "15:00:00", teacherId: T1, otherTitle: "ECA Club", otherKind: "ECA", nickname: "Bank" },
      { id: "3", date: "2026-10-05", startTime: "15:00:00", teacherId: T2, otherTitle: "ECA Club", otherKind: "ECA", nickname: "Nok" },
      { id: "4", date: "2026-10-07", startTime: "10:00:00", teacherId: T1, otherTitle: "Free play", otherKind: "FREE", nickname: "Bank" },
    ];
    const groups = groupForBackfill(rows, mint);
    expect(groups.map((g) => [g.key, g.title, g.teacherId, g.rows.map((r) => r.id)])).toEqual([["key-1", "ECA Club", T1, ["2", "1"]], ["key-2", "ECA Club", T2, ["3"]], ["key-3", "Free play", T1, ["4"]]]);
    expect(describeGroup(groups[0]!)).toBe("ECA Club · ECA · 15:00 · Bank · 2 rows (2026-10-05 … 2026-10-12)");
  });
  test("by source: the query excludes CAMP (the human kinds only) and keyed rows; the apply is ONE tx and re-checks `IS NULL`; dry-run is the default", () => {
    const S = readFileSync(resolve(root, "scripts/backfill-other-series.ts"), "utf8");
    expect(S).toContain('a(e(b.bookingType, "OTHER"), inA(b.otherKind, [...HUMAN_OTHER_KINDS]), n(b.otherSeriesKey))');
    expect(S).toContain('const apply = process.argv.includes("--apply");');
    expect(S).toContain('if (!apply) { console.log("DRY RUN — nothing written. Re-run with --apply."); return; }');
    expect(S).toContain("await db.transaction(async (tx) => {");
    expect(S).toContain("isNull(bookings.otherSeriesKey), eq(bookings.bookingType, \"OTHER\")");
    expect(S.replace(/^\s*\/\/.*$/gm, "")).not.toMatch(/CAMP/); // the code never names CAMP — the kind list excludes it
  });
});
