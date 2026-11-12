// 🔻 TASK-942 — several groups may rent the park in ONE hour: a PARK block (an OTHER booking on the system teacher "No Teacher") holds no coach-hour (`bookings.slot_exempt`, migration 0078), a REAL teacher still cannot be double-booked.
// DB-free: the migration TEXT / journal / witness are pinned by value; `insertBooking` / `moveBooking` run against a fake executor whose `insert` enforces the SAME predicate the index has (`holdsSlot`'s four terms) —
// that models the index, it does not replace it: the real unique index is proven by the rolled-back sid run (inbox/SA-B.md). The money case (two households, two confirm days, one hour) runs the REAL `parkFeeLine` + `writeRevenueLine`.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { bookings } from "../db/schema";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { holdsSlot, slotHolderWhere } from "./slot-holder";
import { isParkBlock } from "./system-teacher";
import { parkFeeLine } from "./booking-sale-amount";
import { writeRevenueLine } from "./revenue-line";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const sched = await import("../services/scheduler.service");
const { db } = await import("../db");
const { ApiException } = await import("./http");

const root = resolve(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
afterEach(() => setSystemTime());

const PARK = "p0p0p0p0-p0p0-40p0-80p0-p0p0p0p0p0p0"; // the system teacher
const REAL = "r1r1r1r1-r1r1-41r1-81r1-r1r1r1r1r1r1";
const DATE = "2099-06-06", HOUR = "10:00";

type Row = { teacherId: string; date: string; startTime: string; status: string; groupId: string | null; slotYieldedAt: null; slotExempt: boolean; bookingType: string };
/** A fake executor: the two teacher rows, no closed day / leave; its `insert` is a PARTIAL UNIQUE INDEX with `holdsSlot`'s predicate — a clash throws pg 23505 exactly as postgres-js does. */
function fakeExec() {
  const rows: Row[] = [];
  let n = 0;
  const teachers: Record<string, any> = {
    [PARK]: { id: PARK, nickname: "No Teacher", isSystem: true, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FREELANCE" },
    [REAL]: { id: REAL, nickname: "Ek", isSystem: false, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME" },
  };
  const exec: any = {
    query: {
      teachers: { findFirst: async (q: any) => teachers[q.where({}, { eq: (_c: unknown, v: string) => v })] },
      closedDays: { findFirst: async () => undefined },
      teacherLeaveDays: { findFirst: async () => undefined },
      bookings: { findFirst: async () => undefined },
    },
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          const clash = rows.some((r) => r.teacherId === v.teacherId && r.date === v.date && r.startTime === v.startTime && holdsSlot(r) && holdsSlot({ status: v.status ?? "PENDING", groupId: v.groupId ?? null, slotYieldedAt: null, slotExempt: v.slotExempt }));
          if (clash) throw Object.assign(new Error("duplicate key value violates unique constraint bookings_teacher_slot_uq"), { code: "23505" });
          rows.push({ teacherId: v.teacherId, date: v.date, startTime: v.startTime, status: v.status ?? "PENDING", groupId: v.groupId ?? null, slotYieldedAt: null, slotExempt: v.slotExempt, bookingType: v.bookingType });
          return [{ id: `b${++n}` }];
        },
      }),
    }),
  };
  return { exec, rows };
}
const other = (teacherId: string, extra: Record<string, unknown> = {}) =>
  ({ teacherId, subjectId: null, date: DATE, startTime: HOUR, bookingType: "OTHER", otherTitle: "Park rental", otherPriceMinor: 50000, status: "CONFIRMED", ...extra });
const insert = async (exec: any, input: any) => {
  const prev = (db.query.bookings as any).findFirst;
  (db.query.bookings as any).findFirst = async () => undefined; // describeSlotClash's own read — never reach the network
  try { return await sched.insertBooking(exec, null, input); } finally { (db.query.bookings as any).findFirst = prev; }
};
const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof ApiException ? { status: e.status, code: e.code } : e; } return null; };

describe("🔴 TASK-942 — the park block holds no coach-hour; a real teacher still does", () => {
  test("3 park blocks in ONE hour on the system teacher → all stored (each stamped slot_exempt)", async () => {
    const { exec, rows } = fakeExec();
    for (let i = 0; i < 3; i++) await insert(exec, other(PARK, { otherTitle: `Group ${i}` }));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.slotExempt === true && r.teacherId === PARK && r.startTime === HOUR)).toBe(true);
  });
  test("a REAL teacher still cannot be double-booked: the second booking in the hour is 409 SLOT_TAKEN", async () => {
    const { exec, rows } = fakeExec();
    await insert(exec, other(REAL));
    expect(await refusal(insert(exec, other(REAL)))).toEqual({ status: 409, code: "SLOT_TAKEN" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slotExempt).toBe(false);
  });
  test("a request body with `slotExempt: true` for a real teacher is IGNORED (the flag comes from the teacher ROW)", async () => {
    const { exec, rows } = fakeExec();
    await insert(exec, other(REAL, { slotExempt: true }));
    expect(rows[0]!.slotExempt).toBe(false);
    expect(await refusal(insert(exec, other(REAL, { slotExempt: true })))).toEqual({ status: 409, code: "SLOT_TAKEN" }); // …so the real teacher's hour is still held
  });
  test("a lesson on the system teacher is still refused (400) — the exemption is for the OTHER park block only", async () => {
    const { exec } = fakeExec();
    expect(await refusal(insert(exec, other(PARK, { bookingType: "SINGLE_SESSION" })))).toEqual({ status: 400, code: "SYSTEM_TEACHER_NOT_BOOKABLE" });
  });
  test("`isParkBlock`: only an OTHER on the system teacher; a real teacher / any other type is false and needs no read", async () => {
    const { exec } = fakeExec();
    expect(await isParkBlock(exec, PARK, "OTHER")).toBe(true);
    expect(await isParkBlock(exec, REAL, "OTHER")).toBe(false);
    expect(await isParkBlock({ query: { teachers: { findFirst: () => { throw new Error("no read for a non-OTHER"); } } } }, PARK, "SINGLE_SESSION")).toBe(false);
  });
});

describe("🔴 TASK-942 — moving an OTHER keeps the flag honest (no real teacher is ever left exempt)", () => {
  const SVC = read("src/services/scheduler.service.ts");
  test("`moveBooking` restamps `slotExempt` from the NEW teacher's row whenever the teacher changes", () => {
    expect(SVC).toContain("if (patch.teacherId) patch.slotExempt = await isParkBlock(tx, patch.teacherId, current.bookingType);");
  });
  test("`insertBooking` stores `slotExempt` from `isParkBlock` (the row's flag), never from `input`", () => {
    expect(SVC).toContain("slotExempt: await isParkBlock(exec, input.teacherId, input.bookingType),");
    expect(SVC).not.toMatch(/slotExempt:\s*input\./);
  });
});

// ═════════════ 🔻 fix D-155-1 (Tanya, TEST-155): the calendar payload carried ONE booking per hour — a slot now has an optional `more` ═════════════
describe("🔴 D-155-1 — `getCalendar`: the park blocks beyond the first reach the screen as `slot.more`; every other slot is byte-identical", () => {
  const { spyOn } = require("bun:test") as typeof import("bun:test");
  const camp = require("../services/camp.service");
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
  const D = "2026-10-21";
  const teacher = (id: string, nickname: string, isSystem = false) => ({ id, name: nickname, nickname, active: true, type: isSystem ? "FREELANCE" : "FULL_TIME", isSystem, workDays: [0, 1, 2, 3, 4, 5, 6], teacherSubjects: [], archived: false });
  const NOTEACHER = teacher(PARK, "No Teacher", true), EK = teacher(REAL, "Ek");
  const base = { endTime: "11:00:00", student: null, coStudent: null, subject: null, course: null, badges: [], rental: null, seats: [], group: null, groupId: null, courseId: null, campWeekDayId: null, campWeekDay: null, teacherRateMinor: null, pendingSlot: false, additionalTeachers: [] };
  const mk = (id: string, t: ReturnType<typeof teacher>, status: string, o: Record<string, unknown> = {}) =>
    ({ ...base, id, date: D, startTime: "10:00", bookingType: "OTHER", otherKind: "RENT", otherTitle: id, teacherId: t.id, teacher: t, status, slotExempt: t.isSystem, ...o });
  const arm = (rows: any[]) => {
    spies.push(spyOn(db.query.teachers, "findMany").mockImplementation((async () => [NOTEACHER, EK]) as any));
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db.query.appSettings, "findMany").mockImplementation((async () => []) as any));
    spies.push(spyOn(db.query.boItem, "findMany").mockImplementation((async () => []) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows) as any));
    spies.push(spyOn(sched, "lastLessonDatesForCourses").mockImplementation((async () => new Map()) as any));
    spies.push(spyOn(camp, "weeksForCalendar").mockImplementation((async () => []) as any));
  };
  const ADMIN = { teacherId: null, isSuperAdmin: true, grants: new Set<string>() } as any;
  const slotOf = async (rows: any[], teacherId: string) => {
    arm(rows);
    const cal: any = await sched.getCalendar({ date: D, view: "day" }, ADMIN);
    return cal.days[0].columns.find((c: any) => c.teacher.id === teacherId).slots.find((s: any) => s.time === "10:00");
  };
  test("3 park blocks in ONE hour → `booking` = the first, `more` = the other two, in row order", async () => {
    const s = await slotOf([mk("pk-a", NOTEACHER, "CONFIRMED"), mk("pk-b", NOTEACHER, "PENDING"), mk("pk-c", NOTEACHER, "CONFIRMED")], PARK);
    expect(s.booking.id).toBe("pk-a");
    expect(s.more.map((b: any) => b.id)).toEqual(["pk-b", "pk-c"]);
  });
  test("a real coach's leave record + the active booking that replaced it → NO `more`, and the SAME booking as before (the active one)", async () => {
    const s = await slotOf([mk("leave", EK, "SICK_LEAVE", { slotExempt: false }), mk("active", EK, "CONFIRMED", { slotExempt: false })], REAL);
    expect(s.booking.id).toBe("active");
    expect(s).not.toHaveProperty("more");
  });
  test("a real coach's two rows that somehow share a key → the loser is DROPPED as today, never listed (`more` is for park blocks only)", async () => {
    const s = await slotOf([mk("one", EK, "CONFIRMED", { slotExempt: false }), mk("two", EK, "CONFIRMED", { slotExempt: false })], REAL);
    expect(s.booking.id).toBe("one");
    expect(s).not.toHaveProperty("more");
  });
  test("an hour with ONE booking → the slot is byte-identical: exactly `{ time, booking }`, no `more` key", async () => {
    const s = await slotOf([mk("solo", NOTEACHER, "CONFIRMED")], PARK);
    expect(Object.keys(s).sort()).toEqual(["booking", "time"]);
  });
  test("by source: `more` is built ONLY from a `slotExempt` loser of the key, and spread only when non-empty; the response type carries it", () => {
    const S = read("src/services/scheduler.service.ts");
    expect(S).toContain("} else if ((row as any).slotExempt) {");
    expect(S).toContain("...(more.get(`${date}|${teacher.id}|${time}`)?.length ? { more: more.get(`${date}|${teacher.id}|${time}`)! } : {}),");
    expect(read("src/types/contract.ts")).toContain("slots: Array<{ time: HhMm; booking: BookingDTO | null; more?: BookingDTO[] }>");
  });
});

describe("🔒 TASK-942 — the app mirror and the index are ONE fact (the fourth term)", () => {
  const dialect = new PgDialect();
  test("`slotHolderWhere` renders `slot_exempt = false`; `holdsSlot` says an exempt row holds nothing", () => {
    const q = dialect.sqlToQuery(slotHolderWhere(bookings));
    expect(q.sql).toContain('"slot_exempt" = $');
    expect(q.params.at(-1)).toBe(false);
    expect(holdsSlot({ status: "CONFIRMED", slotExempt: true })).toBe(false);
    expect(holdsSlot({ status: "CONFIRMED", slotExempt: false })).toBe(true);
    expect(holdsSlot({ status: "CONFIRMED" })).toBe(true); // a row that does not carry the flag holds, as before
  });
});

describe("🔒 TASK-942 — migration 0078: the text, the journal, the witness", () => {
  const MIG = read("drizzle/0078_slot_exempt_park_blocks.sql");
  const stmts = MIG.split("--> statement-breakpoint").map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  test("four statements in THIS order: the column, the backfill of the existing park blocks, the DROP, the rebuilt index with `AND NOT slot_exempt`", () => {
    expect(stmts).toEqual([
      `ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "slot_exempt" boolean NOT NULL DEFAULT false;`,
      `UPDATE "bookings" SET "slot_exempt" = true WHERE "teacher_id" IN (SELECT "id" FROM "teachers" WHERE "is_system") AND NOT "slot_exempt";`,
      `DROP INDEX IF EXISTS "bookings_teacher_slot_uq";`,
      `CREATE UNIQUE INDEX "bookings_teacher_slot_uq" ON "bookings" ("teacher_id", "date", "start_time")\nWHERE "status" not in ('CANCELLED', 'PENDING_RESCHEDULE', 'SICK_LEAVE', 'PAUSED') and "group_id" is null and "slot_yielded_at" is null and not "slot_exempt";`,
    ].map((s) => s.replace(/\n/g, MIG.includes("\r\n") ? "\r\n" : "\n")));
  });
  test("additive only (no DROP COLUMN / no DELETE); the HOT-table lock is named, with the honest reason CONCURRENTLY is not used", () => {
    expect(MIG).not.toMatch(/DROP COLUMN|DELETE FROM|TRUNCATE/i);
    expect(MIG).toContain("ACCESS EXCLUSIVE");
    expect(MIG).toContain("No CONCURRENTLY");
  });
  test("the journal: idx 78, the tag, a `when` UNIQUE and the highest (drizzle skips a migration whose `when` is not above the ledger's newest)", () => {
    const j = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const last = j.entries[78]!; // 🔻 TASK-961: 0079 landed after it — 0078 is entry 78 but no longer the LAST; its `when` is still unique and sits right before 0079's
    expect(last).toMatchObject({ idx: 78, tag: "0078_slot_exempt_park_blocks" });
    const whens = j.entries.map((e) => e.when);
    expect(new Set(whens).size).toBe(whens.length);
    expect(j.entries[79]).toMatchObject({ idx: 79, tag: "0079_activity_changes", when: last.when + 1 });
  });
  test("the witness is the index PREDICATE (contains `slot_exempt`) — not the index's existence, not the column", () => {
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0078_slot_exempt_park_blocks")!;
    expect(w).toMatchObject({ probe: { kind: "index-predicate", index: "bookings_teacher_slot_uq", contains: "slot_exempt" }, rerunnable: true });
    expect(w.why).toContain("NOT the index's existence");
    expect(w.why).toContain("NOT the column");
  });
  test("the schema declares the column (NOT NULL, default false) and the index WHERE carries the fourth term", () => {
    const S = read("src/db/schema.ts");
    expect(S).toContain('slotExempt: boolean("slot_exempt").notNull().default(false),');
    expect(S).toContain("and not ${t.slotExempt}`)");
  });
});

describe("💰 TASK-942 — her money case (ขวัญ, 2026-11-13): household A confirmed yesterday, B today, same hour → two lines, each dated its own confirm day", () => {
  /** A recording executor for `writeRevenueLine`: the category exists, every insert is recorded with its `occurredOn`. */
  const recorder = () => {
    const lines: any[] = [];
    const exec: any = {
      select: () => { const c: any = { from: () => c, where: () => c, limit: async () => [{ id: "cat" }], then: (res: any) => res([{ id: "cat" }]) }; return c; },
      insert: () => ({ values: (v: any) => ({ onConflictDoNothing: () => ({ returning: async () => { lines.push(v); return [{ id: `l${lines.length}` }]; } }) }), }),
      transaction: async (fn: any) => fn(exec),
    };
    return { exec, lines };
  };
  const park = (id: string) => parkFeeLine({ id, otherPriceMinor: 50000, otherPriceItemId: null, branch: "BRAVO" }, null)!;
  test("one `rl:booking:<id>` line per block (N groups = N lines), dated the Bangkok day of its own confirm", async () => {
    const { exec, lines } = recorder();
    setSystemTime(new Date("2026-11-12T03:00:00Z")); // household A confirms (yesterday)
    await writeRevenueLine(exec, park("block-A"));
    setSystemTime(new Date("2026-11-13T03:00:00Z")); // household B confirms (today), the SAME hour on the calendar
    await writeRevenueLine(exec, park("block-B"));
    expect(lines.map((l) => [l.idempotencyKey, l.occurredOn, l.amountMinor, l.productName])).toEqual([
      ["rl:booking:block-A", "2026-11-12", 50000, "Park fee"],
      ["rl:booking:block-B", "2026-11-13", 50000, "Park fee"],
    ]);
  });
  test("the line is keyed on the BOOKING, never on (teacher, date, hour) — two blocks of one hour can never collapse into one line", () => {
    expect(park("block-A").idempotencyKey).not.toBe(park("block-B").idempotencyKey);
    expect(park("block-A")).not.toHaveProperty("occurredOn"); // so the writer dates it at the confirm, not at the calendar hour
  });
});
