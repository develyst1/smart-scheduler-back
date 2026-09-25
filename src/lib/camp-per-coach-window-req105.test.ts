// TASK-454 (`REQ-105 §1`, SPEC-091 §1) — a camp day's coaches each get their OWN window (A 10–12 while B works 13–15),
// and the kid count reaches the hour cell.
//
// The migration `0053` merges TASK-443's `camp_week_day_rates` INTO the new `camp_week_day_teachers` — same primary
// key, always read together — and drops the day's `teacher_ids[]` array, backfill inside the file. NULL hours mean
// **the day's window**, resolved at read, so a day-level change still reaches every coach who never asked for their
// own. `camp_weeks.teacher_ids` (the WEEK's roster, and the "my weeks" scope) is deliberately untouched.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { campSlotDiff, wantedCampSlots } from "./camp";
import { toBookingDTO } from "../db/mappers";
import * as v from "../validation";
import * as camp from "../services/camp.service";
import * as sched from "../services/scheduler.service";
import { db } from "../db";
import { campWeekDayTeachers, campWeekDays } from "../db/schema";
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
const SVC = code(src("src/services/camp.service.ts"));
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", D1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });
const day = (over: any = {}) => ({ id: D1, campWeekId: W1, date: "2026-10-05", startTime: "10:00:00", endTime: "15:00:00", editedAt: null, teachers: [], ...over });
const coach = (teacherId: string, over: any = {}) => ({ campWeekDayId: D1, teacherId, startTime: null, endTime: null, rateMinor: 0, ...over });

describe("🔴 the migration — 0053, counted; the merge, the backfill and BOTH drops in one file; the table is the witness", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
  const sql = readFileSync(resolve(root, "drizzle/0053_camp_day_teachers.sql"), "utf8").replace(/\r\n/g, "\n");
  test("56 = 56: `0053_camp_day_teachers` is the 54th file, idx 53, the last; 'expects 54'; the four statements in THIS order", () => {
    expect(files.length).toBe(57);
    expect(journal.entries.length).toBe(57);
    expect(files[53]).toBe("0053_camp_day_teachers.sql");
    expect(journal.entries[53]).toMatchObject({ idx: 53, tag: "0053_camp_day_teachers" });
    expect(sql).toContain("`db:verify` expects 54");
    const stmts = sql.split("--> statement-breakpoint").map((s) => s.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(stmts).toHaveLength(4);
    expect(stmts[0]).toContain('CREATE TABLE IF NOT EXISTS "camp_week_day_teachers"');
    expect(stmts[0]).toContain('PRIMARY KEY ("camp_week_day_id", "teacher_id")');
    expect(stmts[0]).toContain('"start_time" time NULL');
    expect(stmts[0]).toContain('"rate_minor" integer NOT NULL DEFAULT 0');
    // the backfill: every coach on a day, their hours NULL (⇒ the day's), their 0052 rate carried over (0 when none)
    expect(stmts[1]).toContain('INSERT INTO "camp_week_day_teachers"');
    expect(stmts[1]).toContain('unnest(d."teacher_ids")');
    expect(stmts[1]).toContain('LEFT JOIN "camp_week_day_rates" r');
    expect(stmts[1]).toContain('COALESCE(r."rate_minor", 0)');
    expect(stmts[1]).toContain("ON CONFLICT DO NOTHING");
    // …and only THEN the two drops — the backfill reads both of the things it drops
    expect(stmts[2]).toBe('DROP TABLE IF EXISTS "camp_week_day_rates";');
    expect(stmts[3]).toBe('ALTER TABLE "camp_week_days" DROP COLUMN IF EXISTS "teacher_ids";');
    expect(sql.indexOf("INSERT INTO")).toBeLessThan(sql.indexOf("DROP TABLE"));
  });
  test("the witness probes the table it CREATES (the file ends in a DROP, which proves nothing on a re-run), and it is registered in file order", () => {
    // 🔻 TASK-453 added `0054` AFTER this one, so "the last entry" is no longer the property — "registered, in the
    // journal's own order, probing the table it creates" is, and that is what this asserts.
    const i = SCHEDULING_WITNESSES.findIndex((w) => w.tag === "0053_camp_day_teachers");
    const last = SCHEDULING_WITNESSES[i]!;
    expect(SCHEDULING_WITNESSES[i + 1]?.tag).toBe("0054_group_slot_yield");
    expect(last).toMatchObject({ tag: "0053_camp_day_teachers", probe: { kind: "table", table: "camp_week_day_teachers" }, rerunnable: true });
    const S = code(src("src/db/schema.ts"));
    expect(S).toContain('export const campWeekDayTeachers = pgTable(');
    expect(S).toContain('startTime: time("start_time"),');
    expect(S).not.toMatch(/teacherIds: uuid\("teacher_ids"\)[\s\S]{0,80}campWeekDays/); // the DAY's array is gone
    expect(region(S, "export const campWeekDays = pgTable(", "\n);")).not.toContain("teacher_ids");
    // 🚫 the WEEK's own roster column STAYS — it is the default for a new day and the "my weeks" scope
    expect(region(S, "export const campWeeks = pgTable(", "\n);")).toContain('teacherIds: uuid("teacher_ids").array()');
    expect(code(src("src/services/scheduler.service.ts"))).toContain("campWeeks.filter((w: any) => !scope || (w.teacherIds ?? []).includes(scope))");
  });
});

describe("🔴 each coach's OWN window — by value", () => {
  test("`campDayTeachers` resolves NULL to the day's window, keeps an explicit one, and sorts by start then id", () => {
    const out = camp.campDayTeachers(day({ teachers: [coach(B, { startTime: "13:00:00", endTime: "15:00:00", rateMinor: 30000 }), coach(A, { startTime: "10:00:00", endTime: "12:00:00", rateMinor: 50000 })] }));
    expect(out).toEqual([
      { teacherId: A, startTime: "10:00", endTime: "12:00", rateMinor: 50000 },
      { teacherId: B, startTime: "13:00", endTime: "15:00", rateMinor: 30000 },
    ]);
    // NULL ⇒ the day's window, resolved at READ: change the day and the coach follows, with nothing written
    expect(camp.campDayTeachers(day({ teachers: [coach(A)] }))[0]).toEqual({ teacherId: A, startTime: "10:00", endTime: "15:00", rateMinor: 0 });
    expect(camp.campDayTeachers(day({ startTime: "09:00:00", endTime: "11:00:00", teachers: [coach(A)] }))[0]).toMatchObject({ startTime: "09:00", endTime: "11:00" });
    expect(camp.campDayTeachers(day())).toEqual([]);
  });
  test("🔴 the derived rows: A 10–12 + B 13–15 ⇒ exactly those four hours, and overlap needs no special case", () => {
    const wanted = wantedCampSlots([{ teacherId: A, start: "10:00", end: "12:00" }, { teacherId: B, start: "13:00", end: "15:00" }]);
    expect([...wanted].sort()).toEqual([`${A}|10:00`, `${A}|11:00`, `${B}|13:00`, `${B}|14:00`]);
    // overlapping windows: two coaches on the same hour are two keys — a CAMP row is per coach
    expect([...wantedCampSlots([{ teacherId: A, start: "10:00", end: "11:00" }, { teacherId: B, start: "10:00", end: "11:00" }])].sort()).toEqual([`${A}|10:00`, `${B}|10:00`]);
    // the diff is untouched: moving B's window removes his old rows and inserts the new ones, A's are left alone
    const existing = new Map([[`${A}|10:00`, "r1"], [`${A}|11:00`, "r2"], [`${B}|10:00`, "r3"]]);
    expect(campSlotDiff(wanted, existing)).toEqual({ insert: [`${B}|13:00`, `${B}|14:00`], remove: ["r3"] });
  });
  test("🔴 through the sync (fake tx): each coach's own hours are inserted with their own rate; the kept rows re-stamped", async () => {
    const writes: any[] = [];
    const inserts: any[] = [];
    const tx: any = {
      query: {
        campWeekDays: { findFirst: async () => ({ ...day(), week: { id: W1, name: "Camp A", status: "OPEN" } }) },
        campWeekDayTeachers: { findMany: async () => [coach(A, { startTime: "10:00:00", endTime: "12:00:00", rateMinor: 50000 }), coach(B, { startTime: "13:00:00", endTime: "15:00:00", rateMinor: 30000 })] },
        teachers: { findFirst: async () => null, findMany: async () => [] },
        bookings: { findFirst: async () => null },
      },
      select: () => ({ from: () => ({ where: async () => [{ id: "old-a", teacherId: A, startTime: "10:00:00" }] }) }),
      update: (table: any) => ({ set: (patch: any) => ({ where: async () => { writes.push([table === campWeekDays ? "day" : "bookings", patch]); } }) }),
      delete: () => ({ where: async () => { writes.push(["delete"]); } }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
    };
    spies.push(spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, _s: any, input: any) => { inserts.push(input); return `new-${inserts.length}`; }) as any));
    const out = await camp.syncCampDayRows(tx, D1);
    expect(inserts.map((i) => [i.teacherId, i.startTime, i.teacherRates])).toEqual([
      [A, "11:00", { [A]: 50000 }],
      [B, "13:00", { [B]: 30000 }],
      [B, "14:00", { [B]: 30000 }],
    ]);
    expect(out).toEqual({ inserted: 3, deleted: 0 });
    expect(writes.filter((w) => w[0] === "bookings" && "teacherRateMinor" in w[1]).map((w) => w[1])).toEqual([{ teacherRateMinor: 50000 }, { teacherRateMinor: 30000 }]);
  });
  test("`setDayTeachers` by value: upsert each, delete whoever left; a half-given window ⇒ 400; a window OUTSIDE the day's default is allowed", async () => {
    const writes: any[] = [];
    const tx: any = {
      query: { campWeekDays: { findFirst: async () => ({ ...day(), week: { status: "CLOSED" } }) }, campWeekDayTeachers: { findMany: async () => [] }, teachers: { findMany: async () => [] } },
      insert: (table: any) => ({ values: (val: any) => ({ onConflictDoUpdate: async (o: any) => { writes.push(["upsert", table === campWeekDayTeachers ? "teachers" : "other", val, Object.keys(o.set)]); } }) }),
      delete: (table: any) => ({ where: async () => { writes.push(["delete", table === campWeekDayTeachers ? "teachers" : "other"]); } }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
      select: () => ({ from: () => ({ where: async () => [] }) }),
    };
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    spies.push(spyOn(db.query.campWeeks, "findFirst").mockImplementation((async () => ({ id: W1, name: "Camp A", status: "OPEN", startDate: "2026-10-05", endDate: "2026-10-05", capacity: null, teacherIds: [A], windowStart: null, windowEnd: null, openedAt: new Date(), createdAt: new Date() })) as any));
    spies.push(spyOn(db.query.campWeekDays, "findFirst").mockImplementation((async () => day({ teachers: [coach(A)] })) as any));
    // a coach OUTSIDE the day's 10–15 default: allowed, on purpose (the default is a default, not a clamp)
    await camp.updateWeekDay(W1, "2026-10-05", { teachers: [{ teacherId: A, startTime: "08:00", endTime: "10:00" }, { teacherId: B }] });
    expect(writes.filter((w) => w[0] === "upsert").map((w) => [w[1], w[2].teacherId, w[2].startTime, w[2].endTime])).toEqual([["teachers", A, "08:00", "10:00"], ["teachers", B, null, null]]);
    expect(writes.filter((w) => w[0] === "delete")).toEqual([["delete", "teachers"]]); // whoever is no longer listed
    await expect(camp.updateWeekDay(W1, "2026-10-05", { teachers: [{ teacherId: A, startTime: "08:00" }] })).rejects.toMatchObject({ status: 400 });
    expect(v.updateCampWeekDay.safeParse({ teachers: [{ teacherId: A, startTime: "08:00", endTime: "10:00", rateMinor: 50000 }] }).success).toBe(true);
    expect(v.updateCampWeekDay.safeParse({ teachers: [{ teacherId: A, rateMinor: -1 }] }).success).toBe(false);
    expect(v.updateCampWeekDay.safeParse({ teacherIds: [A] }).success).toBe(true); // 🔻 the old shape, one deploy
  });
  test("`dayTeacherInputs` — the old pair still parses into the new list, and TASK-443's off-day refusal survives", () => {
    const current = [{ teacherId: A, startTime: "08:00", endTime: "10:00", rateMinor: 50000 }, { teacherId: B, startTime: "10:00", endTime: "15:00", rateMinor: 0 }];
    const win = { start: "10:00", end: "15:00" };
    expect(camp.dayTeacherInputs({}, current, win)).toBeNull(); // neither shape given ⇒ the coach set is untouched
    // `teachers` wins outright
    expect(camp.dayTeacherInputs({ teachers: [{ teacherId: B }], teacherIds: [A] }, current, win)).toEqual([{ teacherId: B }]);
    // the old pair: a coach who had OWN hours keeps them; one on the default stays NULL (so a day change reaches them)
    expect(camp.dayTeacherInputs({ teacherRates: { [A]: 1000 } }, current, win)).toEqual([
      { teacherId: A, startTime: "08:00", endTime: "10:00", rateMinor: 1000 },
      { teacherId: B, rateMinor: 0 },
    ]);
    expect(camp.dayTeacherInputs({ teacherIds: [B] }, current, win)).toEqual([{ teacherId: B, rateMinor: 0 }]);
    expect(() => camp.dayTeacherInputs({ teacherRates: { "not-on-day": 1 } }, current, win)).toThrow("ตั้งค่าเรทได้เฉพาะครูที่อยู่ในวันนี้");
    expect(camp.dayTeacherInputs({ teacherIds: ["x"], teacherRates: { x: 1 } }, current, win)).toEqual([{ teacherId: "x", rateMinor: 1 }]); // on the day by THIS body
  });
});

describe("🔴 the DTO — the new shape, the two derived views, and the kid count on the hour cell", () => {
  test("`weekDays` carries `teachers` (resolved) and derives `teacherIds` / `teacherRates` from it — one deploy only", async () => {
    spies.push(spyOn(db.query.campWeeks, "findFirst").mockImplementation((async () => ({ id: W1, name: "Camp A", status: "OPEN", startDate: "2026-10-05", endDate: "2026-10-05", capacity: 10, teacherIds: [A], windowStart: null, windowEnd: null, openedAt: new Date(), createdAt: new Date() })) as any));
    spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async () => []) as any));
    spies.push(spyOn(db.query.campWeekDays, "findMany").mockImplementation((async () => [day({ teachers: [coach(A, { startTime: "10:00:00", endTime: "12:00:00", rateMinor: 50000 }), coach(B)] })]) as any));
    const d = (await camp.weekDays(W1)).days[0]!;
    expect(d.teachers).toEqual([
      { teacherId: A, startTime: "10:00", endTime: "12:00", rateMinor: 50000 },
      { teacherId: B, startTime: "10:00", endTime: "15:00", rateMinor: 0 },
    ]);
    expect(d.teacherIds).toEqual([A, B]);
    expect(d.teacherRates).toEqual({ [A]: 50000, [B]: 0 });
    expect(SVC).toContain("teacherIds: teachers.map((t) => t.teacherId),"); // derived — the two can never disagree
  });
  test("🔴 the hour cell carries the DATE's kid count — the SAME number on every block of that day (it counts children on the day, not children with this coach)", () => {
    const row = { id: "b1", date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", status: "CONFIRMED", bookingType: "OTHER", otherKind: "CAMP", teacherId: A, teacher: { id: A, name: "Ek" }, student: null, subject: null, additionalTeachers: [], campWeekDayId: D1 };
    expect(toBookingDTO(row, { campKidCount: 7 }).campKidCount).toBe(7);
    expect(toBookingDTO(row).campKidCount).toBeNull(); // a reader that did not ask gets null, never a guess
    const CAL = region(code(src("src/services/scheduler.service.ts")), "export async function getCalendar(", "export async function getBookings(");
    expect(CAL).toContain("const campWeeks = await weeksForCalendar(range);");
    expect(CAL).toContain("campKidCount: row.campWeekDayId ? (kidsByDate.get(row.date) ?? 0) : null");
    expect((CAL.match(/weeksForCalendar\(range\)/g) ?? []).length).toBe(1); // ONE read feeds the banner and the cells
    expect(code(src("src/db/mappers.ts"))).toContain("campKidCount: opts.campKidCount ?? null,");
  });
});
