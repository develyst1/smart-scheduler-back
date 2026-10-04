// TASK-625 (@Sober's finding while reading for item E; the owner ruled it into this round: "3 รอบนี้เลย") — a "from here on"
// swap paid the NEW teacher at the OLD teacher's rate.
//
// 🔴 The defect, exactly: the per-session swap wrote `{ teacherId, teacherRateMinor }` and refused when it could not find a rate;
//    the from-here-on swap wrote `{ teacherId }` ALONE and left `teacher_rate_minor` where it was ⇒ the incoming teacher was paid
//    at the outgoing teacher's stored rate, silently, on every row it moved. It is money, and it is wrong in ONE direction.
// 🔑 The fix is NOT a second rule: `seriesRateOf` + `RATE_REQUIRED` already existed and were already right. The rule is asked
//    ONCE, for every scope and both locations, BEFORE the loop — so a swap we cannot rate moves NOTHING.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as series from "../services/other-series.service";
import * as sched from "../services/scheduler.service";
import * as lineLib from "./line";
import * as v from "../validation";
import { db } from "../db";
import { bookingTeachers, bookings } from "../db/schema";
import { readSrc } from "./read-src";
import { bodyEditsCoachRate } from "./coach-rate-visibility"; // TASK-584 — the key-59 gate's own predicate

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code("src/services/other-series.service.ts");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const SWAP = region(SVC, "export async function swapOtherSeriesTeacher(", "export async function swapGroupSeriesTeacher(");
const K = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // the outgoing PRIMARY, paid 50000
const T2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // an extra, paid 40000
const T3 = "ffffffff-ffff-4fff-8fff-ffffffffffff"; // the incoming teacher
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const extra = (teacherId: string, rateMinor: number | null) => ({ teacherId, rateMinor, teacher: { id: teacherId, nickname: "x", name: "x", lineUserId: `U-${teacherId}` } });
const row = (over: any = {}) => ({
  id: `b-${over.date ?? "x"}`, date: "2026-10-12", startTime: "15:00:00", endTime: "16:00:00", status: "PENDING", bookingType: "OTHER",
  teacherId: T1, otherTitle: "ECA Club", otherKind: "ECA", headCount: 12, note: null, teacherRateMinor: 50000, otherSeriesKey: K,
  additionalTeachers: [extra(T2, 40000)], teacher: { id: T1, nickname: "Bank", name: "Bank", lineUserId: "U1" }, ...over,
});
/** 🔑 T3 is paid 28000 in this series — on a PAST row, as an extra. T1 (going out) is on 50000: the two must never be confused. */
const rows = (over: any = {}) => [
  row({ id: "b1", date: "2026-10-05", status: "ATTENDED", additionalTeachers: [extra(T2, 40000), extra(T3, 28000)], ...over }),
  row({ id: "b2", date: "2026-10-12", status: "CONFIRMED" }),
  row({ id: "b3", date: "2026-10-19", status: "PENDING" }),
];
/** The same series with NO memory of T3 — nothing to pay them by. */
const rowsWithoutT3 = () => [row({ id: "b2", date: "2026-10-12", status: "CONFIRMED" }), row({ id: "b3", date: "2026-10-19", status: "PENDING" })];

const fakeTx = (seriesRows: any[]) => {
  const writes: any[] = [];
  const named = (t: any) => (t === bookingTeachers ? "bookingTeachers" : t === bookings ? "bookings" : "other");
  const tx: any = {
    query: {
      teacherLeaveDays: { findFirst: async () => undefined },
      bookings: {
        findMany: async ({ where }: any) => {
          const probe: string[] = [];
          try { where({ otherSeriesKey: "k", bookingType: "t", teacherId: "tid", date: "d", startTime: "s", id: "id" }, { and: (...a: any[]) => a, eq: (c: any, val: any) => { probe.push(String(c)); return val; }, inArray: () => null, ne: () => null, notInArray: () => null, gte: () => null, lte: () => null, or: () => null, isNull: () => null }); } catch {}
          return probe.includes("k") ? seriesRows : [];
        },
        findFirst: async ({ where }: any) => {
          const probe: any[] = [];
          try { where({ teacherId: "tid", date: "d", startTime: "s", id: "id" }, { and: (...a: any[]) => a, eq: (c: any, val: any) => { probe.push([String(c), val]); return val; }, ne: () => null, notInArray: () => null, inArray: () => null, or: () => null }); } catch {}
          return seriesRows.find((r) => r.id === probe.find((p) => p[0] === "id")?.[1]) ?? null;
        },
      },
      teachers: {
        findFirst: async () => ({ id: T3, nickname: "Ple", name: "Ple", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME", lineUserId: "U3" }),
        findMany: async () => [{ id: T1, lineUserId: "U1" }, { id: T2, lineUserId: "U2" }, { id: T3, lineUserId: "U3" }],
      },
      boItem: { findMany: async () => [] },
      appSettings: { findMany: async () => [], findFirst: async () => null },
    },
    insert: (table: any) => ({ values: (val: any) => { writes.push({ op: "insert", table: named(table), val }); return Object.assign(Promise.resolve(), { returning: async () => [{ id: "new" }], onConflictDoNothing: async () => {} }); } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: async () => { writes.push({ op: "update", table: named(table), patch }); } }) }),
    delete: (table: any) => ({ where: async () => { writes.push({ op: "delete", table: named(table) }); } }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
  return { tx, writes };
};
const arm = (seriesRows: any[]) => {
  const { tx, writes } = fakeTx(seriesRows);
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async () => ({ status: "queued" }) as any)) as any);
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
  return { writes };
};

describe("🔴 TASK-625 — a from-here-on swap pays the INCOMING teacher, on every row it moves", () => {
  test("🔑 by value: both rows get T3's OWN rate (28000, found where T3 held it) — never T1's 50000 left in place", async () => {
    const { writes } = arm(rows());
    expect(await series.swapOtherSeriesTeacher(K, { from: T1, to: T3, fromDate: "2026-10-06" })).toEqual({ moved: 2 });
    expect(writes.filter((w) => w.op === "update").map((w) => w.patch)).toEqual([
      { teacherId: T3, teacherRateMinor: 28000 },
      { teacherId: T3, teacherRateMinor: 28000 },
    ]);
    // 🔴 the defect's own shape, pinned as an ABSENCE: no row is left carrying the outgoing teacher's rate
    expect(writes.filter((w) => w.op === "update").map((w) => w.patch.teacherRateMinor)).not.toContain(50000);
    expect(writes.filter((w) => w.op === "update").every((w) => "teacherRateMinor" in w.patch)).toBe(true);
  });

  test("🔑 a given rate wins over the series' memory, in the from-here-on scope too (§8 — the admin can answer the refusal)", async () => {
    const { writes } = arm(rows());
    expect(await series.swapOtherSeriesTeacher(K, { from: T1, to: T3, fromDate: "2026-10-06", rateMinor: 31000 })).toEqual({ moved: 2 });
    expect(writes.filter((w) => w.op === "update").map((w) => w.patch.teacherRateMinor)).toEqual([31000, 31000]);
  });

  test("🔴 a swap it cannot rate moves NOTHING — refused before the first row, not half-way through twelve", async () => {
    const { writes } = arm(rowsWithoutT3());
    await expect(series.swapOtherSeriesTeacher(K, { from: T1, to: T3, fromDate: "2026-10-06" })).rejects.toMatchObject({ code: "RATE_REQUIRED", status: 400 });
    expect(writes).toEqual([]); // 🔑 not "one row moved and then it stopped" — nobody can see where a half-swap stopped
  });

  test("✅ the PER-SESSION behaviour is unchanged: one row, the given rate, the rows after it untouched", async () => {
    const { writes } = arm(rows());
    expect(await series.swapOtherSeriesTeacher(K, { from: T1, to: T3, onDate: "2026-10-12", rateMinor: 45000 })).toEqual({ moved: 1 });
    expect(writes.filter((w) => w.op === "update").map((w) => w.patch)).toEqual([{ teacherId: T3, teacherRateMinor: 45000 }]);
  });

  test("✅ and the per-session refusal is unchanged — no rate to pay the cover with ⇒ RATE_REQUIRED, nothing written", async () => {
    const { writes } = arm(rowsWithoutT3());
    await expect(series.swapOtherSeriesTeacher(K, { from: T1, to: T3, onDate: "2026-10-12" })).rejects.toMatchObject({ code: "RATE_REQUIRED" });
    expect(writes).toEqual([]);
  });

  test("🔻 TASK-629's extra path takes the SAME rule — one resolution serves both locations", async () => {
    const { writes } = arm(rows());
    expect(await series.swapOtherSeriesTeacher(K, { from: T2, to: T3, fromDate: "2026-10-06" })).toEqual({ moved: 2 });
    expect(writes.filter((w) => w.op === "insert").map((w) => w.val[0].rateMinor)).toEqual([28000, 28000]);
    expect(writes.filter((w) => w.table === "bookings")).toEqual([]); // still nothing on the primary's column
  });
});

describe("🔑 TASK-625 — ONE rule, proven by the ABSENCE of a second resolution site", () => {
  test("the rate is resolved ONCE in the whole act, and BEFORE the loop", () => {
    expect(SWAP).toContain("const rate = input.rateMinor ?? seriesRateOf(rows, input.to);");
    expect(SWAP).toContain("if (rate == null) throw RATE_REQUIRED(targets[0].date);");
    expect((SWAP.match(/seriesRateOf\(/g) ?? []).length).toBe(1); // 🔴 no second resolution — not per scope, not per location
    expect((SWAP.match(/RATE_REQUIRED\(/g) ?? []).length).toBe(1);
    expect(SWAP.indexOf("const rate =")).toBeLessThan(SWAP.indexOf("for (const r of targets)"));
    // 🚫 and the scope fork that WAS the defect is gone: no write may depend on `onDate` for whether a rate is written
    expect(SWAP).not.toContain("input.onDate ? { teacherId: input.to, teacherRateMinor:");
    expect(SWAP).not.toMatch(/coverRate|extraRate/);
  });
  test("🔴 the one write carries the rate, in both scopes; the extra path carries the SAME number onto its own row", () => {
    expect(SWAP).toContain("await tx.update(bookings).set({ teacherId: input.to, teacherRateMinor: rate }).where(eq(bookings.id, r.id));");
    expect(SWAP).toContain("await attachAdditionalTeachers(tx, r.id, [input.to], { [input.to]: rate });");
  });
  test("§8 — the door takes a rate in BOTH scopes now, and the contract change is stated where it happened", () => {
    expect(v.otherSeriesSwap.safeParse({ from: T1, to: T3, fromDate: "2026-10-12", rateMinor: 40000 }).success).toBe(true);
    expect(v.otherSeriesSwap.safeParse({ from: T1, to: T3, onDate: "2026-10-12", rateMinor: 40000 }).success).toBe(true);
    // 🚫 what did NOT widen: a scope is still compulsory, and the same teacher twice is still refused
    expect(v.otherSeriesSwap.safeParse({ from: T1, to: T3, rateMinor: 40000 }).success).toBe(false);
    expect(v.otherSeriesSwap.safeParse({ from: T1, to: T1, fromDate: "2026-10-12", rateMinor: 40000 }).success).toBe(false);
    const RAW = readSrc(readFileSync(resolve(root, "src/validation.ts"), "utf8"));
    expect(RAW).toContain("This is a CONTRACT CHANGE even though nothing is rejected differently today");
  });
  test("⚠️ the rate is still PRIVILEGED in both scopes — TASK-584's key-59 gate reads the body, not the scope", () => {
    const API = code("src/routes/api.ts");
    expect(API).toContain('assertMayEditCoachRate(c.req.valid("json"), viewerOf(c));');
    // 🔑 the gate keys off the BODY carrying a rate field, never off which scope was named — so widening `rateMinor` to
    // `fromDate` could not have widened WHO may send one. Asserted by value on the predicate itself.
    expect(bodyEditsCoachRate({ from: T1, to: T3, fromDate: "2026-10-12", rateMinor: 40000 })).toBe(true);
    expect(bodyEditsCoachRate({ from: T1, to: T3, onDate: "2026-10-12", rateMinor: 40000 })).toBe(true);
    expect(bodyEditsCoachRate({ from: T1, to: T3, fromDate: "2026-10-12" })).toBe(false); // a swap without a rate is not privileged
  });
});
