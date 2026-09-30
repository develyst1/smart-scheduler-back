// TASK-581 (REQ-110 item 8, the owner's ruling) — Close stops NEW bookings only. Existing bookings stay. Open re-allows. Nothing else.
// The week's status is read by `planDays` (the gate — TASK-560's pins drive both of its routes) and by NOTHING else: the flip
// writes the week row only, so close ⇒ open leaves the week EXACTLY as it was — asserted here by value over every table it
// could touch. Coach blocks (past AND future), both reminders and the per-day swap run on a closed week as on an open one;
// the day-end cut still charges a closed week's days (they are existing bookings, delivered).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import * as camp from "../services/camp.service";
import { campReminderSends, type CampDayInput, type CampWeekInput } from "./camp-reminder";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from) + from.length));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

// ── a world of every row a close could touch, and a tx that APPLIES what it is asked to (so a stray write shows as a value) ──
const dialect = new PgDialect();
const camel = (s: string) => s.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
const whereOf = (cond: any) => {
  const { sql, params } = dialect.sqlToQuery(cond);
  const eqs = [...sql.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)].map((m) => ({ col: camel(m[2]!), val: params[Number(m[3]) - 1] }));
  return (r: any) => eqs.every((c) => r[c.col] === c.val);
};
type World = Record<"camp_weeks" | "camp_week_days" | "camp_week_day_teachers" | "bookings" | "camp_days", any[]>;
const W = "w-1";
const world = (): World => ({
  camp_weeks: [{ id: W, name: "Oct Camp", startDate: "2026-09-28", endDate: "2026-10-09", status: "OPEN", closedAt: null, capacity: 20, teacherIds: ["t1", "t2"], windowStart: "10:00:00", windowEnd: "15:00:00", openedBy: "admin", openedAt: new Date("2026-09-01T03:00:00Z") }],
  camp_week_days: [
    { id: "wd-past", campWeekId: W, date: "2026-09-28", startTime: "10:00:00", endTime: "15:00:00", editedAt: null },
    { id: "wd-future", campWeekId: W, date: "2026-10-05", startTime: "10:00:00", endTime: "12:00:00", editedAt: new Date("2026-09-20T03:00:00Z") },
  ],
  camp_week_day_teachers: [
    { campWeekDayId: "wd-past", teacherId: "t1", startTime: null, endTime: null, rateMinor: 60000 },
    { campWeekDayId: "wd-future", teacherId: "t2", startTime: "10:00:00", endTime: "12:00:00", rateMinor: 55000 },
  ],
  bookings: [
    { id: "blk-past-10", campWeekDayId: "wd-past", teacherId: "t1", date: "2026-09-28", startTime: "10:00:00", status: "CONFIRMED", teacherRateMinor: 60000 }, // a PAST block: history
    { id: "blk-fut-10", campWeekDayId: "wd-future", teacherId: "t2", date: "2026-10-05", startTime: "10:00:00", status: "CONFIRMED", teacherRateMinor: 55000 },
    { id: "blk-fut-11", campWeekDayId: "wd-future", teacherId: "t2", date: "2026-10-05", startTime: "11:00:00", status: "CONFIRMED", teacherRateMinor: 55000 },
    { id: "private-1", campWeekDayId: null, teacherId: "t1", date: "2026-10-05", startTime: "16:00:00", status: "PENDING" },
  ],
  camp_days: [
    { id: "cd-past", campWeekId: W, campPackageId: "p1", date: "2026-09-28", status: "ATTENDED", units: 2 },
    { id: "cd-future", campWeekId: W, campPackageId: "p1", date: "2026-10-05", status: "PLANNED", units: 1 },
  ],
});
const arm = (w: World) => {
  const log: string[] = [];
  const table = (t: any) => getTableName(t) as keyof World;
  const tx: any = {
    update: (t: any) => ({ set: (patch: any) => ({ where: (cond: any) => {
      const apply = async () => { const name = table(t); log.push(`update:${name}`); const hit = w[name].filter(whereOf(cond)); for (const r of hit) Object.assign(r, patch); return hit; };
      return { then: (a: any, b: any) => apply().then(a, b), returning: apply };
    } }) }),
    delete: (t: any) => ({ where: (cond: any) => {
      const apply = async () => { const name = table(t); const gone = w[name].filter(whereOf(cond)); w[name] = w[name].filter((r) => !gone.includes(r)); log.push(`delete:${name}:${gone.length}`); return gone; };
      return { then: (a: any, b: any) => apply().then(a, b), returning: apply };
    } }),
    // the old close read the week's days to delete their blocks; kept readable so that regression shows as a VALUE
    query: { campWeekDays: { findMany: async () => { log.push("read:camp_week_days"); return w.camp_week_days.filter((d) => d.campWeekId === W); } } },
  };
  spies.push(spyOn(db.query.campWeeks, "findFirst").mockImplementation((async () => ({ ...w.camp_weeks[0] })) as any));
  spies.push(spyOn(db, "transaction").mockImplementation((async (cb: any) => cb(tx)) as any));
  spies.push(spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: () => ({ groupBy: async () => [] }) }) })) as any)); // the DTO's day counts
  return log;
};

describe("🔑 TASK-581 — close ⇒ open ⇒ the week EXACTLY as it was, by VALUE, over every table a close could touch", () => {
  test("CLOSE writes the week row ONLY (status + closedAt): every block — past AND future — every day, coach row and child's day untouched", async () => {
    const w = world(), before = structuredClone(w);
    const log = arm(w);
    const r = await camp.updateWeek(W, { status: "CLOSED" });
    expect(r.week.status).toBe("CLOSED");
    expect(w.camp_weeks[0]!.closedAt).toBeInstanceOf(Date);
    expect({ ...w, camp_weeks: before.camp_weeks }).toEqual(before); // everything but the week row, identical
    expect({ ...w.camp_weeks[0], status: "OPEN", closedAt: null }).toEqual(before.camp_weeks[0]); // the week row: only those two fields
    expect(log).toEqual(["update:camp_weeks"]);
  });
  test("🔴 CLOSE ⇒ OPEN ⇒ the whole world deep-equal to before — the past block included (the old close deleted it and OPEN re-derived only the future)", async () => {
    const w = world(), before = structuredClone(w);
    const log = arm(w);
    await camp.updateWeek(W, { status: "CLOSED" });
    const r = await camp.updateWeek(W, { status: "OPEN" });
    expect(w).toEqual(before);
    expect([r.week.status, r.week.closedAt, r.onLeave]).toEqual(["OPEN", null, []]);
    expect(log).toEqual(["update:camp_weeks", "update:camp_weeks"]);
  });
  test("a CLOSED week is swapped like an open one: the per-day edit passes the week check (here it reaches the day lookup — no 409)", async () => {
    spies.push(spyOn(db.query.campWeeks, "findFirst").mockImplementation((async () => ({ ...world().camp_weeks[0], status: "CLOSED" })) as any));
    spies.push(spyOn(db.query.campWeekDays, "findFirst").mockImplementation((async () => undefined) as any));
    const e: any = await camp.updateWeekDay(W, "2026-10-05", { startTime: "10:00" }).catch((x) => x);
    expect([e.status, e.message]).toEqual([404, "ไม่พบวันแคมป์"]);
  });
  test("both reminders run on a CLOSED week: its coach gets the head count, its family gets the child's row", () => {
    const weeks: CampWeekInput[] = [{ id: W, name: "Oct Camp", status: "CLOSED", teachers: [{ id: "t2", lineUserId: "Ut2" }] }];
    const days: CampDayInput[] = [{ dayId: "cd-future", weekId: W, half: "AM", status: "PLANNED", studentId: "s1", studentName: "น้องเอ", parentId: "p1", parentLineUserIds: ["Up1"] }];
    expect(campReminderSends(days, weeks, "2026-10-05").map((s) => [s.recipientType, s.lineUserId])).toEqual([["teacher", "Ut2"], ["parent", "Up1"]]);
  });
});

describe("⚖️ TASK-581 — a CLOSED week STILL CHARGES its existing days (deliberate: they are existing bookings, and they run)", () => {
  test("by value: the day cut marks a closed week's due day ATTENDED and consumes its units — it never asks the week", async () => {
    const writes: any[] = [];
    const tx: any = {
      select: () => ({ from: () => ({ where: async () => [{ id: "cd-future", packageId: "p1", units: 1 }] }) }),
      update: (t: any) => ({ set: (p: any) => ({ where: async () => { writes.push([getTableName(t), Object.keys(p)]); } }) }),
      query: new Proxy({}, { get: (_t, k) => { throw new Error(`the cut read ${String(k)}`); } }), // any week read would throw
    };
    expect(await camp.cutCampDays(tx, "2026-10-05")).toBe(1);
    expect(writes).toEqual([["camp_days", ["status", "markedBy", "markChannel", "markActor", "markedAt"]], ["camp_packages", ["usedUnits"]]]);
  });
  test("by source: neither the cut nor the BALANCE CAMP pass reads the week or its status", () => {
    const S = code("src/services/camp.service.ts");
    const CUT = region(S, "export async function cutCampDays(", "export async function notifyCampDeductions(");
    const NOTE = region(S, "export async function notifyCampDeductions(", "\n}\n");
    for (const f of [CUT, NOTE]) expect(f).not.toMatch(/campWeeks|week\b|"OPEN"|"CLOSED"/);
  });
});

describe("🔑 TASK-581 — the week status is read by the GATE and by nothing else that acts", () => {
  test("by source: `planDays` refuses a non-OPEN week; the sync, the swap, the week update's tx and the reminders never read the status", () => {
    const S = code("src/services/camp.service.ts");
    expect(region(S, "export async function planDays(", "export async function redeemDays(")).toContain('if (w.status !== "OPEN") throw conflict("CAMP_WEEK_CLOSED", `สัปดาห์ ${w.name} ปิดรับแล้ว`);');
    expect(region(S, "export async function syncCampDayRows(", "export async function updateWeekDay(")).not.toMatch(/status === "OPEN"|week\.status/);
    expect(region(S, "export async function updateWeekDay(", "export async function listPackages(")).not.toMatch(/CAMP_WEEK_CLOSED|w\.status/);
    expect(region(S, "export async function campReminderInputs(", "\n}\n")).not.toMatch(/"OPEN"/);
    expect(code("src/lib/camp-reminder.ts")).not.toMatch(/"OPEN"|\.status !== /);
    // every remaining reader of a WEEK's status, named: the gate, the DTO / banner (display), and the flip itself
    const readers = [...S.matchAll(/\b(\w+)\.status\b/g)].map((m) => m[1]).filter((x) => ["w", "week", "u", "updated"].includes(x!));
    expect(readers).toEqual(["w", "w", "w", "w"]); // toWeekDTO · planDays's GATE · the reminder input (carried, not acted on) · the calendar banner
    expect(S.match(/w\.status !== "OPEN"/g)).toHaveLength(1); // the ONE comparison left is the gate
  });
});
