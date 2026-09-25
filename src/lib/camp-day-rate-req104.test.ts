// TASK-443 (`REQ-104 §2` items 4–5, SPEC-090 §2–§3) — CAMP per-coach-per-day rate (migration `0052`: the rates table as
// witness + `camp_days.deduction_notified_at`; 56 = 56), the day DTO's `teacherRates` (0 by absence; masked without key 59), the
// PATCH's upsert (a coach not on the day ⇒ 400; the field ⇒ 403 without 59) and the ONE sync copying the day rate onto the
// derived rows (inserted with it, KEPT rows re-stamped), the two scan payloads (camp `credit` in DAYS, half-day `3.5`; Private
// `remaining` course / voucher / null), and the DAY-END `camp_deduction` pass by value (CONSUMING days not yet stamped ⇒ one row
// per family account, a skipped row without one, the stamp = the idempotency; ATTENDED and ABSENT alike), the 25th kind's
// ENGLISH-ONLY bytes under both langs. The Private deduction and the cut's first pass byte-identical.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { CAMP_DEDUCTION_TITLE, renderCampDeduction, unitsToDays } from "./camp-deduction";
import * as v from "../validation";
import * as camp from "../services/camp.service";
import * as checkin from "../services/checkin.service";
import * as sched from "../services/scheduler.service";
import * as familyLink from "./family-link";
import * as lineLib from "./line";
import { db } from "../db";
import { bookings, campDays, campWeekDayTeachers, campWeekDays } from "../db/schema";
import { DEV_USER } from "../middleware/auth";
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
const SVC = code(src("src/services/camp.service.ts"));
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", D1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", T2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", T3 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const P1 = "11111111-1111-4111-8111-111111111111", S1 = "22222222-2222-4222-8222-222222222222";
const spies: Array<{ mockRestore: () => void }> = [];
const savedUser = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
const setUser = (u: { isSuperAdmin: boolean; grants?: Iterable<string>; teacherId?: string | null }) => {
  (DEV_USER as any).isSuperAdmin = u.isSuperAdmin; (DEV_USER as any).grants = new Set(u.grants ?? []); (DEV_USER as any).teacherId = u.teacherId ?? null;
};
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, savedUser); });
const week = { id: W1, name: "Camp A", status: "OPEN", startDate: "2026-10-05", endDate: "2026-10-05", capacity: 10, teacherIds: [T1, T2], windowStart: null, windowEnd: null, openedAt: new Date(), createdAt: new Date() };

describe("🔴 the migration — 0052, counted; the stamp column then the rates TABLE = the witness (LAST); the schema", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
  const sql = readFileSync(resolve(root, "drizzle/0052_camp_day_rates.sql"), "utf8").replace(/\r\n/g, "\n");
  test("56 = 56: `0052_camp_day_rates` is the 53rd file, idx 52 (TASK-454 added 0053 after it); 'expects 53'; the two statements", () => {
    expect(files.length).toBe(57);
    expect(journal.entries.length).toBe(57);
    expect(files[52]).toBe("0052_camp_day_rates.sql");
    expect(journal.entries[52]).toMatchObject({ idx: 52, tag: "0052_camp_day_rates" });
    expect(sql).toContain("`db:verify` expects 53");
    const stmts = sql.split("--> statement-breakpoint").map((s) => s.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(stmts).toEqual([
      `ALTER TABLE "camp_days" ADD COLUMN IF NOT EXISTS "deduction_notified_at" timestamp with time zone;`,
      `CREATE TABLE IF NOT EXISTS "camp_week_day_rates" ( "camp_week_day_id" uuid NOT NULL REFERENCES "camp_week_days"("id") ON DELETE CASCADE, "teacher_id" uuid NOT NULL REFERENCES "teachers"("id") ON DELETE RESTRICT, "rate_minor" integer NOT NULL DEFAULT 0, PRIMARY KEY ("camp_week_day_id", "teacher_id") );`,
    ]);
  });
  test("🔴 the witness is INHERITED from 0053 (TASK-459): its own table is gone, so it can no longer be observed", () => {
    // 🔻 TASK-454 merged `camp_week_day_rates` into `camp_week_day_teachers` and `0053` dropped it.
    // 🔴 TASK-459 — **this very line used to assert the defect.** It said the table probe "stands (a box that has not
    // run 0053 still needs it)", which sounds right and is not: on a box that HAS run 0053 — every correctly
    // migrated box — the probe reads `found=false`, so `db:seed-ledger` calls 0052 not-applied and offers to apply
    // it, which would re-create the retired table and undo the merge. That is what halted `sid` on 2026-09-24.
    // 📌 The reassuring half of my own sentence was the part that was wrong; a witness cannot serve a box that has
    // not run 0053 if it lies to every box that has. The 0002 → 0007 shape is the answer: inherit the verdict.
    expect(SCHEDULING_WITNESSES.find((w) => w.tag === "0052_camp_day_rates")).toMatchObject({ probe: { kind: "superseded-by", tag: "0053_camp_day_teachers" }, rerunnable: false });
    const S = code(src("src/db/schema.ts"));
    expect(S).not.toContain("export const campWeekDayRates = pgTable(");
    expect(S).toContain("export const campWeekDayTeachers = pgTable(");
    expect(S).toContain('rateMinor: integer("rate_minor").notNull().default(0),');
    expect(S).toContain("(t) => [primaryKey({ columns: [t.campWeekDayId, t.teacherId] })],");
    expect(S).toContain("teachers: many(campWeekDayTeachers),");
    expect(S).toContain('deductionNotifiedAt: timestamp("deduction_notified_at", { withTimezone: true }),');
  });
});

describe("🔴 the rate — the day DTO (0 by absence), the PATCH's upsert (off-day ⇒ 400), the ONE sync copies it; key 59 on the write and the read", () => {
  test("`weekDays` by value: `teacherRates` for every coach ON the day, 0 when none was set (🔻 TASK-454: the ROW is the membership, so a rate for a coach not on the day can no longer exist at all)", async () => {
    spies.push(spyOn(db.query.campWeeks, "findFirst").mockImplementation((async () => week) as any));
    spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async () => []) as any));
    spies.push(spyOn(db.query.campWeekDays, "findMany").mockImplementation((async () => [{ id: D1, campWeekId: W1, date: "2026-10-05", startTime: "10:00:00", endTime: "15:00:00", editedAt: null, teachers: [{ campWeekDayId: D1, teacherId: T1, startTime: null, endTime: null, rateMinor: 50000 }, { campWeekDayId: D1, teacherId: T2, startTime: null, endTime: null, rateMinor: 0 }] }]) as any));
    const out = await camp.weekDays(W1);
    expect(out.days[0]).toMatchObject({ date: "2026-10-05", campWeekDayId: D1, teacherIds: [T1, T2], teacherRates: { [T1]: 50000, [T2]: 0 } });
    expect(out.days[0]!.teacherRates).not.toHaveProperty(T3);
    // …and the new shape the old two are derived FROM: each coach's resolved window + rate
    expect(out.days[0]!.teachers).toEqual([
      { teacherId: T1, startTime: "10:00", endTime: "15:00", rateMinor: 50000 },
      { teacherId: T2, startTime: "10:00", endTime: "15:00", rateMinor: 0 },
    ]);
    expect(v.updateCampWeekDay.safeParse({ teacherRates: { [T1]: 50000 } }).success).toBe(true);
    expect(v.updateCampWeekDay.safeParse({ teacherRates: { [T1]: -1 } }).success).toBe(false);
  });
  test("`updateWeekDay` by value through a fake tx: the upsert per coach (ON CONFLICT ⇒ update), then the sync inserts WITH the rate and re-stamps the KEPT rows; a coach off the day ⇒ 400 before any write", async () => {
    const day = { id: D1, campWeekId: W1, date: "2026-10-05", startTime: "10:00:00", endTime: "12:00:00", editedAt: null, teachers: [{ teacherId: T1, startTime: null, endTime: null, rateMinor: 0 }, { teacherId: T2, startTime: null, endTime: null, rateMinor: 0 }] };
    spies.push(spyOn(db.query.campWeeks, "findFirst").mockImplementation((async () => week) as any));
    // 🔻 TASK-454 — the re-read after the tx sees the coach ROWS as they were just upserted (the DTO is built from them)
    spies.push(spyOn(db.query.campWeekDays, "findFirst").mockImplementation((async () => ({ ...day, teachers: upserted.length ? upserted : day.teachers })) as any));
    const writes: any[] = [];
    const upserted: any[] = [];
    const tx: any = {
      query: {
        campWeekDays: { findFirst: async () => ({ ...day, week }) },
        campWeekDayTeachers: { findMany: async () => upserted.map((u) => ({ campWeekDayId: D1, teacherId: u.teacherId, startTime: u.startTime ?? null, endTime: u.endTime ?? null, rateMinor: u.rateMinor })) },
        teachers: { findFirst: async () => null, findMany: async () => [] },
        bookings: { findFirst: async () => null },
      },
      select: () => ({ from: () => ({ where: async () => [{ id: "old-1", teacherId: T1, startTime: "10:00:00" }, { id: "old-2", teacherId: T2, startTime: "10:00:00" }] }) }),
      insert: (table: any) => ({ values: (val: any) => ({ onConflictDoUpdate: async (o: any) => { if (table !== campWeekDayTeachers) throw new Error("wrong table"); upserted.push(val); writes.push(["upsert", val, Object.keys(o.set)]); } }) }),
      update: (table: any) => ({ set: (patch: any) => ({ where: async () => { writes.push(["update", table === bookings ? "bookings" : table === campWeekDays ? "day" : "other", patch]); } }) }),
      delete: (table: any) => ({ where: async () => { writes.push(["delete", table === campWeekDayTeachers ? "teachers" : "other"]); } }),
    };
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    const inserts: any[] = [];
    spies.push(spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, _s: any, input: any) => { inserts.push(input); return `new-${inserts.length}`; }) as any));
    const out = await camp.updateWeekDay(W1, "2026-10-05", { teacherRates: { [T1]: 50000, [T2]: 30000 } });
    expect(writes.filter((w) => w[0] === "upsert")).toEqual([["upsert", { campWeekDayId: D1, teacherId: T1, startTime: null, endTime: null, rateMinor: 50000 }, ["startTime", "endTime", "rateMinor"]], ["upsert", { campWeekDayId: D1, teacherId: T2, startTime: null, endTime: null, rateMinor: 30000 }, ["startTime", "endTime", "rateMinor"]]]);
    expect(inserts.map((i) => [i.teacherId, i.startTime, i.teacherRates])).toEqual([[T1, "11:00", { [T1]: 50000 }], [T2, "11:00", { [T2]: 30000 }]]);
    expect(writes.filter((w) => w[0] === "update" && w[1] === "bookings" && "teacherRateMinor" in w[2]).map((w) => w[2])).toEqual([{ teacherRateMinor: 50000 }, { teacherRateMinor: 30000 }]); // the KEPT 10:00 rows
    expect(writes.findIndex((w) => w[0] === "upsert")).toBeLessThan(inserts.length ? writes.findIndex((w) => w[0] === "update" && w[1] === "bookings") : Infinity); // the upsert BEFORE the sync
    // 🔻 TASK-454 — the DTO is re-read from the coach ROWS, so it now shows what was just written for BOTH coaches
    // (before the merge the fixture could only answer with the one rate it was seeded with).
    expect(out).toMatchObject({ day: { date: "2026-10-05", teacherRates: { [T1]: 50000, [T2]: 30000 } }, inserted: 2, deleted: 0 });
    // a coach not on the day ⇒ 400, and the sync never ran
    writes.length = 0; inserts.length = 0;
    await expect(camp.updateWeekDay(W1, "2026-10-05", { teacherRates: { [T3]: 1000 } })).rejects.toMatchObject({ status: 400, message: "ตั้งค่าเรทได้เฉพาะครูที่อยู่ในวันนี้" });
    expect(writes.filter((w) => w[0] === "upsert")).toEqual([]);
    expect(inserts).toEqual([]);
    // the coaches the body sets are the ones the upsert checks against
    await expect(camp.updateWeekDay(W1, "2026-10-05", { teacherIds: [T3], teacherRates: { [T3]: 1000 } })).resolves.toBeTruthy();
    expect(writes.filter((w) => w[0] === "upsert").map((w) => w[1].teacherId)).toEqual([T3]);
  });
  test("🔴 key 59 through the ROOT app: the field without 59 ⇒ 403 (the service never reached); teachers alone pass; the READ masks `teacherRates` without 59 and shows it with", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    spies.push(spyOn(camp, "updateWeekDay").mockImplementation((async (...a: any[]) => { calls.push(a); return { day: {} }; }) as any));
    spies.push(spyOn(camp, "weekDays").mockImplementation((async () => ({ week: {}, days: [{ date: "2026-10-05", teacherIds: [T1], teacherRates: { [T1]: 50000 }, startTime: "10:00" }] })) as any));
    setUser({ isSuperAdmin: false, grants: ["menu:camp", "action:camp.week-open"] });
    expect((await json("PATCH", `/camp/weeks/${W1}/days/2026-10-05`, { teacherRates: { [T1]: 50000 } })).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await json("PATCH", `/camp/weeks/${W1}/days/2026-10-05`, { teacherIds: [T1] })).status).toBe(200);
    expect(calls).toHaveLength(1);
    const masked = await (await json("GET", `/camp/weeks/${W1}/days`)).json() as any;
    expect(masked.days[0].teacherRates).toBeNull(); // the ONE mask nulls the key by name (TASK-431's shape)
    expect(masked.days[0]).toMatchObject({ teacherIds: [T1], startTime: "10:00" });
    setUser({ isSuperAdmin: false, grants: ["menu:camp", "action:camp.week-open", "action:bookings.coach-rate"] });
    expect((await json("PATCH", `/camp/weeks/${W1}/days/2026-10-05`, { teacherRates: { [T1]: 50000 } })).status).toBe(200);
    expect((await (await json("GET", `/camp/weeks/${W1}/days`)).json() as any).days[0].teacherRates).toEqual({ [T1]: 50000 });
    expect(code(src("src/routes/camp.ts"))).toContain("assertMayEditCoachRate(c.req.valid(\"json\"), viewerOf(c));");
  });
});

describe("🔴 the two scans carry what is left — camp `credit` in DAYS (half-day ⇒ 3.5), Private `remaining` course / voucher / null; no mask", () => {
  test("`checkinCampByToken` (already) ⇒ `credit: { remainingDays, totalDays }` = (total − used) / 2", async () => {
    spies.push(spyOn(db.query.campDays, "findFirst").mockImplementation((async () => ({ id: "d1", campWeekId: W1, campPackageId: P1, date: "2026-10-05", half: "AM", units: 1, status: "ATTENDED", undoReason: null })) as any));
    spies.push(spyOn(db.query.campPackages, "findFirst").mockImplementation((async () => ({ id: P1, studentId: S1, kind: "FULL", plan: "FULL_WEEK", totalUnits: 10, usedUnits: 3, createdAt: new Date() })) as any));
    spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async () => []) as any));
    expect(await camp.checkinCampByToken("tok-12345678")).toEqual({ already: true, day: { dayId: "d1", weekId: W1, date: "2026-10-05", half: "AM", units: 1, status: "ATTENDED", undoReason: null }, credit: { remainingDays: 3.5, totalDays: 5 } });
    expect(unitsToDays(8)).toBe(4);
    expect(region(SVC, "export async function checkinCampByToken(", "const dayDTO")).toContain("credit: creditDTO(pkg)"); // the attend path too
  });
  test("`checkinByToken` (already) ⇒ `remaining` from the course, ONE voucher read for a voucher row, null on a trial", async () => {
    const base = { id: "b1", status: "ATTENDED", date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", bookingType: "COURSE_PACKAGE", teacherId: T1, studentId: S1, student: { id: S1, name: "Aiwa" }, teacher: { id: T1, name: "Ek" }, subject: { name: "Freeskate" }, additionalTeachers: [], rental: null };
    let row: any = { ...base, courseId: "c1", course: { id: "c1", size: 10, usedSessions: 4, startDate: "2026-09-01", startTime: "10:00:00", weekday: 1, expiryDate: "2027-01-01", usedSessions_: 0 } };
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => row) as any));
    const vSpy = spyOn(db.query.vouchers, "findFirst").mockImplementation((async () => ({ id: "v1", totalHours: 10, usedHours: 6 })) as any); spies.push(vSpy);
    expect((await checkin.checkinByToken("tok-12345678") as any).remaining).toEqual({ used: 4, total: 10, unit: "sessions" });
    expect(vSpy).not.toHaveBeenCalled();
    row = { ...base, bookingType: "VOUCHER", voucherId: "v1", course: null };
    expect((await checkin.checkinByToken("tok-12345678") as any).remaining).toEqual({ used: 6, total: 10, unit: "hours" });
    expect(vSpy).toHaveBeenCalledTimes(1);
    row = { ...base, bookingType: "FIRST_TRIAL", course: null };
    expect((await checkin.checkinByToken("tok-12345678") as any).remaining).toBeNull();
    expect(code(src("src/services/checkin.service.ts"))).toContain("return { already: false, booking: result.booking, crmAwarded: CRM_POINT_RULES.ON_TIME_CHECKIN, remaining: await remainingOf(row, result.booking) };");
  });
});

describe("🔴 the DAY-END `camp_deduction` pass by value — CONSUMING days not yet stamped; one row per family account; a skipped row without one; the stamp; ATTENDED and ABSENT alike; after the cut", () => {
  test("the pass", async () => {
    const pkg = { id: P1, studentId: S1, totalUnits: 10, usedUnits: 3, student: { id: S1, name: "Aiwa", nickname: "Aiwa" } };
    const probes: any[] = [];
    const writes: any[] = [];
    const tx: any = {
      query: { campDays: { findMany: async ({ where, with: w }: any) => { const p: any[] = []; try { where({ status: "status", date: "date", deductionNotifiedAt: "stamp" }, { and: (...a: any[]) => a, inArray: (c: any, val: any) => { p.push(["in", c, val]); return val; }, lte: (c: any, val: any) => { p.push(["lte", c, val]); return val; }, isNull: (c: any) => { p.push(["isNull", c]); return c; } }); } catch {} probes.push({ p, w }); return [
        { id: "d1", campPackageId: P1, date: "2026-10-05", status: "ATTENDED", package: pkg },
        { id: "d2", campPackageId: P1, date: "2026-10-04", status: "ABSENT", package: { ...pkg, studentId: "s-none", student: { name: "Bam", nickname: null } } },
      ]; } } },
      update: (table: any) => ({ set: (patch: any) => ({ where: async () => { writes.push([table === campDays ? "campDays" : "other", patch]); } }) }),
    };
    spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async (_e: any, ids: any[]) => (ids[0] === S1 ? ["Ua", "Ub"] : [])) as any));
    const sends: any[] = [];
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any, exec: any) => { sends.push([o, exec === tx]); return { status: "queued" } as any; }) as any));
    expect(await camp.notifyCampDeductions(tx, "2026-10-05")).toBe(2);
    expect(probes[0].p).toEqual([["in", "status", ["ATTENDED", "ABSENT"]], ["lte", "date", "2026-10-05"], ["isNull", "stamp"]]);
    expect(probes[0].w).toEqual({ package: { with: { student: true } } });
    const payload = { kind: "camp_deduction", studentName: "Aiwa", date: "2026-10-05", remainingDays: 3.5, totalDays: 5 };
    expect(sends).toEqual([
      [{ recipientType: "parent", recipientLineUserId: "Ua", payload }, true],
      [{ recipientType: "parent", recipientLineUserId: "Ub", payload }, true],
      [{ recipientType: "parent", recipientLineUserId: null, payload: { ...payload, studentName: "Bam", date: "2026-10-04" } }, true], // no account ⇒ ONE skipped row (the Private shape)
    ]);
    expect(writes.map((w) => [w[0], Object.keys(w[1])])).toEqual([["campDays", ["deductionNotifiedAt"]], ["campDays", ["deductionNotifiedAt"]]]);
    expect(writes[0]![1].deductionNotifiedAt).toBeInstanceOf(Date);
    expect(sends.every((s) => !("bookingId" in s[0]))).toBe(true); // a camp day has no booking row
  });
  test("by source: the pass runs INSIDE the day-end tx AFTER the cut; the cut's first pass and the Private deduction byte-identical; no flag", () => {
    const J = code(src("src/services/jobs.service.ts"));
    const tx = region(J, "const marked = await db.transaction(", "return { autoAttended");
    expect(tx).toContain("const campDaysAutoAttended = await cutCampDays(tx, runDate);");
    expect(tx).toContain("const campDeductionsNotified = await notifyCampDeductions(tx, runDate);");
    expect(tx.indexOf("notifyCampDeductions")).toBeGreaterThan(tx.indexOf("cutCampDays(tx, runDate)"));
    expect((J.match(/notifyCourseDeduction\(tx, \{/g) ?? []).length).toBe(2); // the Private deduction's two day-end sites, untouched
    const K = region(SVC, "export async function cutCampDays(", "\n}\n");
    expect(K).toContain('await tx.update(campDays).set({ status: "ATTENDED", markedBy: "end-of-day", markedAt: new Date() }).where(eq(campDays.id, d.id));');
    expect(K).not.toContain("enqueueLine"); // the cut cuts; the pass notifies
    expect(region(SVC, "export async function markDay(", "\n}\n")).not.toContain("enqueueLine"); // not at scan / not at the manual mark — the owner's ruling
    expect(SVC).not.toMatch(/camp_deduction_enabled|getSetting\("camp_deduction/);
  });
  test("🔴 the bytes — REQ-104 §3, ENGLISH ONLY: identical under TH and EN, no Thai code point, DD-MM-YYYY, `3.5` and `4` (never `4.0`); an empty payload renders; the branch has no `t()`/`lang`", () => {
    const expected = "🏕️ CAMP CREDIT USED\nStudent : Aiwa\nDate : 05-10-2026\nRemaining : 3.5/5 days";
    expect(renderCampDeduction({ studentName: "Aiwa", date: "2026-10-05", remainingDays: 3.5, totalDays: 5 })).toBe(expected);
    expect(renderCampDeduction({ studentName: "Aiwa", date: "2026-10-05", remainingDays: 4, totalDays: 5 })).toBe("🏕️ CAMP CREDIT USED\nStudent : Aiwa\nDate : 05-10-2026\nRemaining : 4/5 days");
    expect(CAMP_DEDUCTION_TITLE).toBe("🏕️ CAMP CREDIT USED");
    for (const lang of ["TH", "EN"] as const) {
      const out = formatOutboxMessage({ kind: "camp_deduction", studentName: "Aiwa", date: "2026-10-05", remainingDays: 3.5, totalDays: 5 } as any, { studentName: "น้องเอ" } as any, lang, "parent");
      expect(out).toBe(expected);
      expect(out).not.toMatch(/[฀-๿]/);
      expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    expect(formatOutboxMessage({ kind: "camp_deduction" } as any, {}, "TH", "parent")).toBe("🏕️ CAMP CREDIT USED\nStudent : \nDate : \nRemaining : / days");
    const branch = region(code(src("src/lib/line-message.ts")), 'case "camp_deduction":', "case ");
    expect(branch).not.toMatch(/\bt\(|lang/);
    expect(code(src("src/lib/camp-deduction.ts"))).not.toMatch(/line-i18n|\bt\(/);
  });
});
