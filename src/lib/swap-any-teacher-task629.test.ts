// TASK-629 (REQ-111 item E, back half) — Swap takes ANY teacher off the session, not only the primary.
// Khwan, through the owner: "swap ได้แค่ครูที่เป็น primary ค่ะ ต้องการให้เลือกคนอื่นได้ค่ะ" ⇒ a WIDENING of an existing control.
//
// 🔑 The one fact the whole task turns on: **"primary" is not a flag on a list of people — it is a different STORAGE LOCATION.**
//    The primary is `bookings.teacher_id` (rate: `bookings.teacher_rate_minor`); every other teacher is a `booking_teachers` row
//    (rate: that row's own `rate_minor`). ⇒ ONE branch, chosen ONCE by WHICH LOCATION `from` occupies.
// 🔴 The claims that matter here are the two ABSENCES: a non-primary swap never writes the primary's column or the primary's
//    rate (that would re-rate a teacher nobody asked about), and the branch is never decided twice.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as series from "../services/other-series.service";
import * as sched from "../services/scheduler.service";
import * as lineLib from "./line";
import { seriesRateOf } from "./coach-rate";
import { db } from "../db";
import { bookingTeachers, bookings } from "../db/schema";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code("src/services/other-series.service.ts");
const RAW = readSrc(readFileSync(resolve(root, "src/services/other-series.service.ts"), "utf8")); // the comments kept — §2's warning is a claim about them
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const K = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // the PRIMARY
const T2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // an EXTRA — the one being swapped OUT
const T3 = "ffffffff-ffff-4fff-8fff-ffffffffffff"; // the incoming teacher
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const extra = (teacherId: string, rateMinor: number | null) => ({ teacherId, rateMinor, teacher: { id: teacherId, nickname: "x", name: "x", lineUserId: `U-${teacherId}` } });
const row = (over: any = {}) => ({
  id: `b-${over.date ?? "x"}`, date: "2026-10-12", startTime: "15:00:00", endTime: "16:00:00", status: "PENDING", bookingType: "OTHER",
  teacherId: T1, otherTitle: "ECA Club", otherKind: "ECA", headCount: 12, note: null, teacherRateMinor: 50000, otherSeriesKey: K,
  additionalTeachers: [extra(T2, 40000)], teacher: { id: T1, nickname: "Bank", name: "Bank", lineUserId: "U1" }, ...over,
});
/** 🔑 b1 is PAST and not live, and it is where T3 once held a rate as an EXTRA — the series' own memory of what T3 is paid. */
const rows = () => [
  row({ id: "b1", date: "2026-10-05", status: "ATTENDED", additionalTeachers: [extra(T2, 40000), extra(T3, 35000)] }),
  row({ id: "b2", date: "2026-10-12", status: "CONFIRMED" }),
  row({ id: "b3", date: "2026-10-19", status: "PENDING" }),
];

/**
 * 🔑 The values a drizzle condition is BOUND to, in order — `and(eq(a, x), eq(b, y))` ⇒ `[x, y]`.
 * ⚠️ This exists because mutation E5 — *delete EVERY extra on the row instead of only the outgoing one* — SURVIVED the first
 * version of this file: the harness recorded that a delete happened and nothing about WHO it named, so a row-wide delete and
 * a scoped one looked identical. **A write assertion that does not read the WHERE is an assertion about the verb.**
 */
const boundParams = (w: any): any[] => {
  const out: any[] = [], seen = new Set();
  const walk = (x: any) => {
    if (!x || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    if ("value" in x && (typeof x.value === "string" || typeof x.value === "number")) out.push(x.value);
    for (const k of Object.keys(x)) walk(x[k]);
  };
  walk(w);
  return out;
};

/** A fake tx over an in-memory series (TASK-428's harness shape): every write recorded, the reads answered from `rows`. */
const fakeTx = (seriesRows: any[], opts: { clashOn?: string } = {}) => {
  const writes: any[] = [];
  const named = (t: any) => (t === bookingTeachers ? "bookingTeachers" : t === bookings ? "bookings" : "other");
  const tx: any = {
    query: {
      teacherLeaveDays: { findFirst: async () => undefined },
      bookings: {
        findMany: async ({ where }: any) => {
          const probe: string[] = [];
          try { where({ otherSeriesKey: "k", bookingType: "t", teacherId: "tid", date: "d", startTime: "s", id: "id" }, { and: (...a: any[]) => a, eq: (c: any, v: any) => { probe.push(String(c)); return v; }, inArray: () => null, ne: () => null, notInArray: () => null, gte: () => null, lte: () => null, or: () => null, isNull: () => null }); } catch {}
          return probe.includes("k") ? seriesRows : [];
        },
        findFirst: async ({ where }: any) => {
          const probe: any[] = [];
          try { where({ teacherId: "tid", date: "d", startTime: "s", id: "id" }, { and: (...a: any[]) => a, eq: (c: any, v: any) => { probe.push([String(c), v]); return v; }, ne: () => null, notInArray: () => null, inArray: () => null, or: () => null }); } catch {}
          const d = probe.find((p) => p[0] === "d")?.[1];
          // the APPLICATION clash read (`assertAdditionalTeacherFree`) — the extra path's whole guarantee
          if (opts.clashOn && d === opts.clashOn) return { id: "other", otherTitle: "Camp", student: null, startTime: "15:00:00", endTime: "16:00:00", teacher: { nickname: "Ple", name: "Ple" } };
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
    delete: (table: any) => ({ where: async (w: any) => { writes.push({ op: "delete", table: named(table), params: boundParams(w) }); } }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
  return { tx, writes };
};
/** 🔑 `attachAdditionalTeachers` is NOT stubbed: the insert must go THROUGH the real guards, which is half the task. */
const arm = (seriesRows: any[], opts: { clashOn?: string } = {}) => {
  const { tx, writes } = fakeTx(seriesRows, opts);
  const notices: any[] = [];
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { notices.push(o); return { status: "queued" } as any; }) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async (...a: any[]) => { writes.push({ op: "holds", a: a.slice(1) }); }) as any));
  return { writes, notices };
};

describe("🔴 TASK-629 — a NON-PRIMARY swapped out: a DELETE and an INSERT on another table, and the primary untouched", () => {
  test("🔑 ONE session: the outgoing extra's row GONE, the incoming extra's row INSERTED with their OWN rate — and NO write to `bookings`", async () => {
    const { writes, notices } = arm(rows());
    expect(await series.swapOtherSeriesTeacher(K, { from: T2, to: T3, onDate: "2026-10-12", rateMinor: 45000 })).toEqual({ moved: 1 });
    // 🔴 the two writes, in order, both on `booking_teachers` — and the rate rides on the INCOMING teacher's own row
    expect(writes.filter((w) => w.op !== "holds").map((w) => [w.op, w.table])).toEqual([["delete", "bookingTeachers"], ["insert", "bookingTeachers"]]);
    expect(writes.find((w) => w.op === "insert")!.val).toEqual([{ bookingId: "b2", teacherId: T3, rateMinor: 45000 }]);
    // 🔴 THE ABSENCE: nothing touched the primary's column or the primary's rate — nobody asked about T1
    expect(writes.filter((w) => w.table === "bookings")).toEqual([]);
    expect(writes.filter((w) => w.op === "holds")).toEqual([]); // the holds belong to the PRIMARY column, which did not move
    // the SWAP's pair, per row: the leaving coach and the arriving one
    expect(notices.map((n) => [n.payload.kind, n.bookingId])).toEqual([["teacher_unassigned", "b2"], ["teacher_assigned", "b2"]]);
  });

  test("🔴 the DELETE names the ROW and the OUTGOING TEACHER — a bystander extra on the same session is not swept out with them", async () => {
    const T5 = "11111111-1111-4111-8111-111111111111"; // a third teacher on the session; nobody asked about them
    const withBystander = [
      row({ id: "b1", date: "2026-10-05", status: "ATTENDED", additionalTeachers: [extra(T3, 35000)] }),
      row({ id: "b2", date: "2026-10-12", status: "CONFIRMED", additionalTeachers: [extra(T2, 40000), extra(T5, 30000)] }),
    ];
    const { writes } = arm(withBystander);
    expect(await series.swapOtherSeriesTeacher(K, { from: T2, to: T3, fromDate: "2026-10-06" })).toEqual({ moved: 1 });
    // 🔑 BOTH values bound: the row AND the person. A delete scoped to the row alone would carry only `b2` — and would take T5.
    expect(writes.filter((w) => w.op === "delete").map((w) => w.params)).toEqual([["b2", T2]]);
    expect(writes.find((w) => w.op === "insert")!.val).toEqual([{ bookingId: "b2", teacherId: T3, rateMinor: 35000 }]);
  });

  test("🔑 FROM HERE ON: both live rows from the date, and the rate comes from where T3 ALREADY held one — never the outgoing teacher's", async () => {
    // 📌 By value first: the series' memory of T3 is 35000 (an EXTRA on a past row); T2 — the one being replaced — is on 40000.
    expect(seriesRateOf(rows(), T3)).toBe(35000);
    expect(seriesRateOf(rows(), T2)).toBe(40000);
    const { writes, notices } = arm(rows());
    expect(await series.swapOtherSeriesTeacher(K, { from: T2, to: T3, fromDate: "2026-10-06" })).toEqual({ moved: 2 });
    expect(writes.filter((w) => w.op === "insert").map((w) => w.val[0])).toEqual([
      { bookingId: "b2", teacherId: T3, rateMinor: 35000 },
      { bookingId: "b3", teacherId: T3, rateMinor: 35000 },
    ]);
    expect(writes.filter((w) => w.op === "delete")).toHaveLength(2);
    expect(writes.filter((w) => w.table === "bookings")).toEqual([]); // 🔴 still nothing on the primary
    expect(notices.map((n) => n.payload.kind)).toEqual(["teacher_unassigned", "teacher_assigned", "teacher_unassigned", "teacher_assigned"]);
    // 🚫 and the PAST row (b1, ATTENDED) is not among the writes — the swap never touches what already happened
    expect(writes.filter((w) => JSON.stringify(w).includes("b1"))).toEqual([]);
  });

  test("✅ the PRIMARY path is unchanged BY THIS TASK — same column write, same holds, same pair (🔻 TASK-625 later added the rate)", async () => {
    // ⚠️ NARROWED, not restrung: when TASK-629 shipped, this asserted `{ teacherId: T3 }` and nothing else — the from-here-on swap
    // wrote no rate. 🔻 TASK-625 (the owner's ruling, a money defect) makes it write the INCOMING teacher's rate on every row.
    // 🔑 The claim that survives and is the one this test exists for: the widening did not change the primary path. The RATE did.
    const { writes, notices } = arm(rows());
    expect(await series.swapOtherSeriesTeacher(K, { from: T1, to: T3, fromDate: "2026-10-06" })).toEqual({ moved: 2 });
    expect(writes.filter((w) => w.op === "update").map((w) => [w.table, w.patch])).toEqual([["bookings", { teacherId: T3, teacherRateMinor: 35000 }], ["bookings", { teacherId: T3, teacherRateMinor: 35000 }]]);
    expect(writes.filter((w) => w.op === "holds").map((w) => w.a)).toEqual([["b2", T3, "CONFIRMED", false], ["b3", T3, "PENDING", false]]);
    expect(writes.filter((w) => w.table === "bookingTeachers")).toEqual([]); // the primary path writes no extras table
    expect(notices.map((n) => n.payload.kind)).toEqual(["teacher_unassigned", "teacher_assigned", "teacher_unassigned", "teacher_assigned"]);
  });

  test("✅ the one-session PRIMARY cover still writes the cover's rate on the ROW's override (TASK-562, untouched)", async () => {
    const { writes } = arm(rows());
    expect(await series.swapOtherSeriesTeacher(K, { from: T1, to: T3, onDate: "2026-10-12", rateMinor: 45000 })).toEqual({ moved: 1 });
    expect(writes.filter((w) => w.op === "update").map((w) => w.patch)).toEqual([{ teacherId: T3, teacherRateMinor: 45000 }]);
  });
});

describe("🔴 TASK-629 — every existing refusal survives, and the new one names the date", () => {
  test("🔻 §T-629-MERGE — `from` on NO location of the row ⇒ 400, now in the MERGED sentence", async () => {
    // ⚠️ NARROWED, and the reason is the point: this asserted TASK-428's shipped wording *"ครูคนแรกไม่ใช่คนที่ระบุ"* — kept word
    // for word by TASK-629 so a widening would not quietly reword an existing refusal. 🔑 After TASK-629 that sentence was
    // reachable ONLY in this case — the named teacher on the row in no location at all — where it is TRUE but MISLEADING: it
    // blames the primary when the real fact is that nobody on the session is that person. **The owner ruled the merge knowing
    // it replaces a live sentence.** ⇒ what is asserted now is the ONE fact both cases share.
    const T4 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    arm(rows());
    await expect(series.swapOtherSeriesTeacher(K, { from: T4, to: T3, fromDate: "2026-10-06" })).rejects.toMatchObject({ status: 400, message: "วันที่ 2026-10-12 ครูที่ระบุไม่ได้อยู่ในตารางของวันนั้น" });
  });
  test("🔑 an extra on the FIRST target but not on a later one ⇒ REFUSED, not half-done the other way", async () => {
    // ⚠️ My first version of this test PASSED FOR THE WRONG REASON: the fixture gave T3 no rate anywhere, so `RATE_REQUIRED`
    // — also a 400 — was thrown before the loop ran, and a `{ status: 400 }` assertion could not tell the two apart.
    // 🔑 A refusal test that does not name WHICH refusal is a test of the status code, not of the rule.
    const mixed = [
      row({ id: "b2", date: "2026-10-12", status: "CONFIRMED", additionalTeachers: [extra(T2, 40000), extra("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 1)] }),
      row({ id: "b3", date: "2026-10-19", additionalTeachers: [] }),
    ];
    const withRate = [row({ id: "b0", date: "2026-10-01", status: "ATTENDED", additionalTeachers: [extra(T3, 35000)] }), ...mixed];
    const { writes } = arm(withRate);
    await expect(series.swapOtherSeriesTeacher(K, { from: T2, to: T3, fromDate: "2026-10-06" })).rejects.toMatchObject({
      status: 400,
      // 🔻 §T-629-MERGE — the EXTRA path's own draft sentence is gone too: both cases raise the merged one, naming the row
      // that disagreed. 🔑 The claim here never was the wording — it is that the refusal names WHICH date broke the run.
      message: "วันที่ 2026-10-19 ครูที่ระบุไม่ได้อยู่ในตารางของวันนั้น",
    });
    // ⚠️ b2 WAS written before b3 refused — the roll-back is the TRANSACTION's, which is why this call is one tx
    expect(writes.some((w) => w.op === "insert")).toBe(true);
    expect(SVC).toContain("return db.transaction(async (tx) => {");
  });
  test("`to` already ON the row ⇒ ALREADY_ON_ROW, whichever location they occupy (the primary included — one person, one place)", async () => {
    arm(rows());
    await expect(series.swapOtherSeriesTeacher(K, { from: T2, to: T1, fromDate: "2026-10-06" })).rejects.toMatchObject({ code: "ALREADY_ON_ROW" });
    const both = [row({ id: "b2", date: "2026-10-12", additionalTeachers: [extra(T2, 40000), extra(T3, 30000)] })];
    arm(both);
    await expect(series.swapOtherSeriesTeacher(K, { from: T2, to: T3, fromDate: "2026-10-06" })).rejects.toMatchObject({ code: "ALREADY_ON_ROW" });
  });
  test("🔴 no rate for the incoming extra ANYWHERE in the series ⇒ RATE_REQUIRED, never the outgoing teacher's rate", async () => {
    const noMemory = [row({ id: "b2", date: "2026-10-12", status: "CONFIRMED" })]; // T3 appears nowhere ⇒ no rate to find
    expect(seriesRateOf(noMemory, T3)).toBe(null);
    const { writes } = arm(noMemory);
    await expect(series.swapOtherSeriesTeacher(K, { from: T2, to: T3, fromDate: "2026-10-06" })).rejects.toMatchObject({ code: "RATE_REQUIRED" });
    expect(writes).toEqual([]); // 🔑 refused BEFORE anything is written
  });
  test("🔴 SLOT_TAKEN comes from the real `assertAdditionalTeacherFree` — the extra path goes THROUGH the guards, not around them", async () => {
    const { writes } = arm(rows(), { clashOn: "2026-10-12" });
    await expect(series.swapOtherSeriesTeacher(K, { from: T2, to: T3, onDate: "2026-10-12", rateMinor: 45000 })).rejects.toMatchObject({ code: "SLOT_TAKEN" });
    expect(writes.some((w) => w.op === "insert")).toBe(false); // the delete happened; the INSERT was refused ⇒ one tx, rolled back
  });
});

describe("🔑 TASK-629 — the branch is ONE decision, and the absence is pinned at the source too", () => {
  test("`locationOf` is defined once and ASKED once — the service never re-derives 'is this the primary?'", () => {
    expect(SVC).toContain('const locationOf = (r: SeriesRow, teacherId: string): "primary" | "extra" | "absent" =>');
    // 🔑 exactly ONE call: the definition reads `locationOf = (`, so this regex counts call sites and nothing else.
    expect((SVC.match(/locationOf\(/g) ?? []).length).toBe(1);
    expect(SVC).toContain('const onExtra = locationOf(targets[0], input.from) === "extra";');
    // …and the decision is made BEFORE the row loop, not inside it
    const SWAP = region(SVC, "export async function swapOtherSeriesTeacher(", "export async function swapGroupSeriesTeacher(");
    expect(SWAP.indexOf("const onExtra =")).toBeLessThan(SWAP.indexOf("for (const r of targets)"));
  });
  test("🔴 THE ABSENCE at the source: the extra branch names neither `bookings.teacher_id` nor the primary's rate column", () => {
    const SWAP = region(SVC, "export async function swapOtherSeriesTeacher(", "export async function swapGroupSeriesTeacher(");
    const extraBranch = region(SWAP, "if (onExtra) {", "} else {");
    expect(extraBranch).toContain("tx.delete(bookingTeachers)");
    expect(extraBranch).toContain("attachAdditionalTeachers(tx, r.id, [input.to]");
    expect(extraBranch).not.toMatch(/teacherRateMinor|teacherId: input\.to/);
    // 🔑 the claim is about the WRITE: `teacherRateMinor` still appears in the PRIMARY branch, deliberately (TASK-562's cover)
    expect(region(SWAP, "} else {", "TASK-629 §4")).toContain("teacherRateMinor: rate"); // 🔻 TASK-625 renamed it and gave it BOTH scopes
  });
  test("⚠️ the WEAKER guarantee is written where the new caller is, not left for the next reader to assume", () => {
    // 🔑 read from the RAW source: `SVC` is comment-stripped on purpose (every other claim here is about CODE), so a claim
    // about what the comment says has to come from the file itself, not from the stripped copy.
    const DOC = region(RAW, "🔻 TASK-629 (REQ-111 item E", "export async function swapOtherSeriesTeacher(");
    expect(DOC).toContain("bookings_teacher_slot_uq");
    expect(DOC).toContain("two racing requests can both pass");
    expect(DOC).toContain("different STORAGE LOCATION");
  });
  test("🔑 §4 — ONE notice pair, the SWAP's own, and the reason is in the code (not the add/remove pair the tables suggest)", () => {
    const SWAP = region(SVC, "export async function swapOtherSeriesTeacher(", "export async function swapGroupSeriesTeacher(");
    expect((SWAP.match(/kind: "teacher_unassigned"/g) ?? []).length).toBe(1); // ONE pair, shared by both paths
    expect((SWAP.match(/kind: "teacher_assigned"/g) ?? []).length).toBe(1);
    expect(SWAP).not.toMatch(/other_teacher_added|other_teacher_removed/);
    expect(RAW).toContain("the message belongs to the ACT the admin");
  });
  test("✅ no new door, no new access row, no migration: the widening rides the PATCH that already exists", () => {
    const ACCESS = code("src/lib/route-access.ts");
    expect((ACCESS.match(/"PATCH \/other-series\/:key\/teacher"/g) ?? []).length).toBe(1);
    expect(code("src/routes/api.ts")).toContain('.patch("/other-series/:key/teacher", zValidator("json", v.otherSeriesSwap)');
    expect(code("src/validation.ts")).toContain("export const otherSeriesSwap = z");
  });
});
