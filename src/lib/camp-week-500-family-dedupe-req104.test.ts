// TASK-445 (Tanya's two findings, before the customer-UAT) — (1) the camp-week 500: a coach clash's `23505` ABORTS the transaction
// and the sync's catch then read the coach's name ON THAT TX ⇒ `25P02`, a raw pg error ⇒ 500. The names are read BEFORE any
// insert now; the catch touches no tx ⇒ `409 SLOT_TAKEN` naming date · hour · coach, the whole create rolled back. A PAST date
// derives nothing and is left alone. (2) the group cancel-all's family notices: ONE household set per row (all the seats — two
// siblings reach their family ONCE), the accounts returned for honest counts: `familyNotices` = rows × distinct accounts,
// `householdsTold` = the union across the call. The Private/DUO path byte-identical. No migration (53 = 53).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApiException } from "./http";
import * as camp from "../services/camp.service";
import * as sched from "../services/scheduler.service";
import * as series from "../services/other-series.service";
import * as lineLib from "./line";
import { db } from "../db";
import { bookings, campWeekDays, campWeeks } from "../db/schema";
import { fmtDate, addDays } from "./time";
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
const CAMP = code(src("src/services/camp.service.ts"));
const SCHED = code(src("src/services/scheduler.service.ts"));
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", D1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", T2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", K = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });
const TODAY = fmtDate(new Date()); // the service's own "today" (Bangkok = local on this box; the rule is `date < today`)

/** A camp fake tx: the week + a day; the teachers read; a clash at `clashAt` arrives as `insertBooking`'s 409 — and then, as on a
 *  real Postgres, EVERY further read on the tx throws (`25P02`, the aborted transaction). */
const campTx = (o: { week: any; day: any; existing?: any[]; clashAt?: string }) => {
  const log: any[] = [];
  let aborted = false;
  const guard = <T,>(fn: () => T): T => { if (aborted) throw Object.assign(new Error("current transaction is aborted, commands ignored until end of transaction block"), { code: "25P02" }); return fn(); };
  const tx: any = {
    log,
    query: {
      campWeekDays: { findFirst: async () => guard(() => ({ ...o.day, week: o.week })) },
      campWeekDayRates: { findMany: async () => guard(() => []) },
      teachers: { findFirst: async () => guard(() => ({ id: T1, nickname: "เอก" })), findMany: async () => guard(() => [{ id: T1, nickname: "เอก" }, { id: T2, nickname: "บี" }]) },
      bookings: { findFirst: async () => guard(() => null) },
    },
    select: () => ({ from: () => ({ where: async () => guard(() => o.existing ?? []) }) }),
    insert: (table: any) => ({ values: (val: any) => { const ret = { returning: async () => guard(() => { log.push(["insert", table === campWeeks ? "week" : table === campWeekDays ? "day" : "other", val]); return [{ id: table === campWeeks ? W1 : D1, ...val }]; }) }; return Object.assign(Promise.resolve(), ret); } }),
    delete: () => ({ where: async () => guard(() => { log.push(["delete"]); }) }),
    update: () => ({ set: (patch: any) => ({ where: async () => guard(() => { log.push(["update", patch]); }) }) }),
  };
  const ins = spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, studentId: any, input: any) => {
    if (o.clashAt && input.startTime === o.clashAt) { aborted = true; throw new ApiException(409, "SLOT_TAKEN", "taken"); }
    log.push(["booking", studentId, input]); return `new-${log.length}`;
  }) as any);
  spies.push(ins);
  return { tx, log };
};

describe("🔴 §1 the 500 — the clash's 23505 aborts the tx; the catch no longer reads it: 409 naming date · hour · coach; a past date derives nothing", () => {
  const week = { id: W1, name: "Camp A", status: "OPEN", startDate: TODAY, endDate: TODAY, capacity: 10, teacherIds: [T1], windowStart: null, windowEnd: null, openedAt: new Date(), createdAt: new Date() };
  test("by value: the sync on TODAY's day with a clash at 11:00 ⇒ 409 SLOT_TAKEN with the coach's name — even though every read on the tx now throws 25P02", async () => {
    const f = campTx({ week, day: { id: D1, date: TODAY, teacherIds: [T1], startTime: "10:00:00", endTime: "12:00:00" }, clashAt: "11:00" });
    const e = await camp.syncCampDayRows(f.tx, D1).then(() => null, (e) => ({ status: e.status, code: e.code, message: e.message }));
    expect(e).toEqual({ status: 409, code: "SLOT_TAKEN", message: `วันที่ ${TODAY} 11:00 ครูเอก มีคาบแล้ว — ไม่ได้บันทึกอะไร` });
  });
  test("by source: the names are read BEFORE the insert loop, from the wanted set; the catch touches nothing on the tx", () => {
    const S = region(CAMP, "export async function syncCampDayRows(", "async function deleteCampDayRows(");
    expect(S.indexOf("tx.query.teachers.findMany(")).toBeLessThan(S.indexOf("for (const key of insert) {"));
    const CATCH = region(S, 'if (e instanceof ApiException && e.code === "SLOT_TAKEN") {', "\n      }");
    expect(CATCH).not.toContain("await ");
    expect(CATCH).toContain("coachName.get(teacherId) ?? teacherId");
  });
  test("a PAST date: nothing derived, nothing deleted, no read beyond the day — a week created mid-week cannot clash on yesterday", async () => {
    const f = campTx({ week: { ...week, startDate: addDays(TODAY, -2) }, day: { id: D1, date: addDays(TODAY, -1), teacherIds: [T1], startTime: "10:00:00", endTime: "12:00:00" }, existing: [{ id: "old", teacherId: T1, startTime: "10:00:00" }], clashAt: "10:00" });
    expect(await camp.syncCampDayRows(f.tx, D1)).toEqual({ inserted: 0, deleted: 0 });
    expect(f.log).toEqual([]);
    expect(CAMP).toContain("if (d.date < bangkokNow().date) return { inserted: 0, deleted: 0 };");
  });
  test("🔴 through the ROOT app: `POST /camp/weeks` for a week INCLUDING today over a coach who has a session in the window ⇒ 409 SLOT_TAKEN envelope naming the clash; the tx callback rejected (nothing committed)", async () => {
    process.env.SKIP_AUTH = "true";
    const f = campTx({ week, day: { id: D1, date: TODAY, teacherIds: [T1], startTime: "10:00:00", endTime: "15:00:00" }, clashAt: "13:00" });
    const seen = { outcome: null as "committed" | "rolled back" | null };
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => { try { const r = await fn(f.tx); seen.outcome = "committed"; return r; } catch (e) { seen.outcome = "rolled back"; throw e; } }) as any));
    const res = await json("POST", "/camp/weeks", { name: "Camp A", startDate: TODAY, endDate: TODAY, teacherIds: [T1] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "SLOT_TAKEN", message: `วันที่ ${TODAY} 13:00 ครูเอก มีคาบแล้ว — ไม่ได้บันทึกอะไร` } });
    expect(seen.outcome).toBe("rolled back");
    expect(f.log.filter((l) => l[0] === "booking").map((l) => l[2].startTime)).toEqual(["10:00", "11:00", "12:00"]); // the rows before the clash were attempted inside the tx — and rolled back with it
  });
});

describe("🔴 §2 the family notices — ONE household set per row; siblings once; the counts honest; Private/DUO byte-identical", () => {
  const famTx = (o: { seats?: { studentId: string }[]; student: Record<string, string | null>; parents: Record<string, { lineUserId: string | null; links: string[] }> }, inserted: any[]) => ({
    query: {
      students: { findMany: async () => Object.entries(o.student).map(([id, parentId]) => ({ id, parentId })) },
      parents: { findMany: async () => Object.entries(o.parents).map(([id, p]) => ({ id, lineUserId: p.lineUserId })) },
      bookings: { findMany: async () => o.seats ?? [] },
    },
    select: () => ({ from: () => ({ where: async () => Object.entries(o.parents).flatMap(([parentId, p]) => p.links.map((lineUserId) => ({ parentId, lineUserId }))) }) }),
    insert: () => ({ values: async (val: any) => { inserted.push(val); } }),
  });
  test("two SIBLINGS seated on one GROUP row ⇒ their family's accounts ONCE (TASK-420 told them twice); a third child's household beside; the accounts returned", async () => {
    const inserted: any[] = [];
    const tx = famTx({ seats: [{ studentId: "A" }, { studentId: "B" }, { studentId: "C" }], student: { A: "p1", B: "p1", C: "p2" }, parents: { p1: { lineUserId: "U1", links: ["U1b"] }, p2: { lineUserId: "U2", links: [] } } }, inserted);
    const accounts = await sched.classCancelledFamilyAccounts(tx, { id: "g-1", status: "CONFIRMED", studentId: null, bookingType: "GROUP" }, "ADMIN_ERROR");
    expect(accounts).toEqual(["U1", "U1b", "U2"]);
    expect(inserted.map((r) => r.recipientLineUserId)).toEqual(["U1", "U1b", "U2"]); // U1 once, not twice
    expect(inserted.every((r) => r.payload.kind === "class_cancelled_parent" && r.bookingId === "g-1")).toBe(true);
    // the wrapper the two single-row callers use: 1 = told, 0 = nothing sent
    expect(await sched.sendClassCancelledToFamilies(tx, { id: "g-1", status: "CONFIRMED", studentId: null, bookingType: "GROUP" }, "ADMIN_ERROR")).toBe(1);
    expect(await sched.sendClassCancelledToFamilies(tx, { id: "g-1", status: "PENDING", studentId: null, bookingType: "GROUP" }, "ADMIN_ERROR")).toBe(0);
    expect(await sched.classCancelledFamilyAccounts(tx, { id: "g-2", status: "CONFIRMED", studentId: null, bookingType: "GROUP", seats: [] }, "ADMIN_ERROR")).toBeNull(); // no student on the row ⇒ nothing sent
    // an unlinked household: the skipped row lands, the accounts are none, the wrapper still says told
    const skipped: any[] = [];
    const t2 = famTx({ student: { Z: "p9" }, parents: { p9: { lineUserId: null, links: [] } } }, skipped);
    expect(await sched.classCancelledFamilyAccounts(t2, { id: "b-9", status: "CONFIRMED", studentId: "Z", bookingType: "COURSE_PACKAGE", course: { size: 4 } }, "ADMIN_ERROR")).toEqual([]);
    expect(skipped.map((r) => r.recipientLineUserId)).toEqual([null]);
    expect(await sched.sendClassCancelledToFamilies(t2, { id: "b-9", status: "CONFIRMED", studentId: "Z", bookingType: "COURSE_PACKAGE", course: { size: 4 } }, "ADMIN_ERROR")).toBe(1);
  });
  test("by source: the Private/DUO set is `[studentId, coStudentId]` as before; a GROUP row's set is ALL its seats; ONE `class_cancelled_parent` producer; the two single-row callers unchanged", () => {
    const C = region(SCHED, "export async function classCancelledFamilyAccounts(", "\n}\n");
    expect(C).toContain("const ids: Array<string | null> = seats ? seats.map((s: any) => s.studentId ?? null) : [current.studentId ?? null, current.coStudentId ?? null];");
    expect(C).toContain("const accounts = await householdLineUserIds(tx, ids);");
    expect(C).toContain("await enqueueParentCopies(tx, accounts, { bookingId: current.id, payload });");
    expect(C).not.toContain("for (const"); // ONE set, ONE call — no per-seat loop
    expect((SCHED.match(/kind: "class_cancelled_parent"/g) ?? []).length).toBe(1);
    expect((SCHED.match(/await sendClassCancelledToFamilies\(/g) ?? []).length).toBe(2); // the leave + the admin's cancel, byte-identical callers
    expect(region(SCHED, "export async function sendClassCancelledToFamilies(", "\n}\n")).toContain("return (await classCancelledFamilyAccounts(tx, current, cancelReason)) === null ? 0 : 1;");
  });
  test("🔴 cancel-all by value: one child on SIX rows ⇒ six notices (each its own dated class), `householdsTold: 1`; two rows with different families ⇒ the union", async () => {
    const rows = [1, 2, 3, 4, 5, 6].map((i) => ({ id: `g-${i}`, date: `2026-10-0${i}`, startTime: "15:00:00", endTime: "16:00:00", status: "CONFIRMED", bookingType: "GROUP", teacherId: T1, otherTitle: "Skate Kids", otherKind: "GROUP", headCount: 4, note: null, teacherRateMinor: null, additionalTeachers: [], teacher: { id: T1, nickname: "Ek", name: "Ek", lineUserId: "U-ek" }, seats: [{ id: `s-${i}`, studentId: "A", status: "CONFIRMED", courseId: "c1" }] }));
    const tx: any = {
      query: {
        bookings: { findMany: async () => rows, findFirst: async () => null },
        teachers: { findMany: async () => [{ id: T1, lineUserId: "U-ek" }], findFirst: async () => null },
        boMovement: { findMany: async () => [] }, boItem: { findMany: async () => [], findFirst: async () => null }, appSettings: { findMany: async () => [], findFirst: async () => null },
      },
      insert: () => ({ values: (val: any) => Object.assign(Promise.resolve(), { returning: async () => [{ id: "x" }], onConflictDoNothing: async () => {} }) }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
      delete: () => ({ where: async () => {} }),
      select: () => ({ from: () => ({ where: async () => [] }) }),
    };
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    spies.push(spyOn(sched, "cancelSeatsOfGroup").mockImplementation((async () => 1) as any));
    spies.push(spyOn(sched, "classCancelledFamilyAccounts").mockImplementation((async (_tx: any, current: any) => (current.id === "g-6" ? ["U1", "U1b", "U2"] : ["U1", "U1b"])) as any)); // row 6 seats a second family too
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async () => ({ status: "queued" }) as any) as any));
    const out = await series.cancelAllOtherSeries({ groupKey: K }, { reasonCode: "ADMIN_ERROR" }, "dev");
    expect(out).toEqual({ cancelled: 6, seatsCancelled: 6, familyNotices: 13, householdsTold: 3 }); // 5×2 + 3 rows; the union {U1, U1b, U2}
    expect(out).not.toHaveProperty("familiesTold");
    expect(readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).length).toBe(53);
  });
});
