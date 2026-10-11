// TASK-712 (REQ-116, owner-approved COPY-REVIEW-2026-09-29.md:592 item 2) — a camp coach's OWN hours must sit inside the day's hours, at BOTH ends; refused in Thai, naming the date, the coach and both
// windows; the day's hours are those AFTER this save; and also when ONLY the day's hours change (Tanya's TEST-089 Part 2: the day's end moved to 14:00 and QACT's own 13:00–15:00 stood past it).
// 🔑 Driven by value through the REAL `updateWeekDay` over the fake transaction of camp-day-rate-req104's proof; the transaction ROLLS BACK its recorded writes on a throw, so "nothing was written" is a
// fact the test can read, not an assumption.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as camp from "./camp.service";
import * as sched from "./scheduler.service";
import { db } from "../db";
import { bookings, campWeekDayTeachers, campWeekDays } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const isoPlus = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const CAMP_DAY = isoPlus(bangkokNow().date, 30); // always in the future (the sync skips a past day by design)
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", D1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", MINT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NAMES: Record<string, string> = { [QACT]: "QACT", [MINT]: "มิ้นท์" };
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
const week = { id: W1, name: "Camp A", status: "OPEN", startDate: CAMP_DAY, endDate: CAMP_DAY, capacity: 10, teacherIds: [QACT, MINT], windowStart: null, windowEnd: null, openedAt: new Date(), createdAt: new Date() };

type Stored = { teacherId: string; startTime: string | null; endTime: string | null; rateMinor: number };
const stored = (teacherId: string, startTime: string | null = null, endTime: string | null = null): Stored => ({ teacherId, startTime, endTime, rateMinor: 0 });

/** A camp day [dayStart–dayEnd] whose coaches are `coaches`; returns the harness. The transaction rolls `writes` back when it throws. */
function harness(dayStart: string, dayEnd: string, coaches: Stored[]) {
  const day: any = { id: D1, campWeekId: W1, date: CAMP_DAY, startTime: `${dayStart}:00`, endTime: `${dayEnd}:00`, editedAt: null, teachers: coaches };
  const rows: Stored[] = coaches.map((c) => ({ ...c })); // what the coach table holds RIGHT NOW (the upsert mutates it)
  const writes: any[] = [];
  const inserts: any[] = [];
  spies.push(spyOn(db.query.campWeeks, "findFirst").mockImplementation((async () => week) as any));
  spies.push(spyOn(db.query.campWeekDays, "findFirst").mockImplementation((async () => ({ ...day, teachers: rows })) as any));
  const tx: any = {
    query: {
      teacherLeaveDays: { findFirst: async () => undefined },
      campWeekDays: { findFirst: async () => ({ ...day, week, startTime: writes.some((w) => w[0] === "day") ? day.startTime : day.startTime }) },
      campWeekDayTeachers: { findMany: async () => rows.map((r) => ({ campWeekDayId: D1, ...r })) },
      teachers: { findFirst: async () => null, findMany: async ({ where }: any) => { void where; return Object.entries(NAMES).map(([id, nickname]) => ({ id, nickname, name: nickname })); } },
      bookings: { findFirst: async () => null },
    },
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: (table: any) => ({ values: (val: any) => ({ onConflictDoUpdate: async () => {
      if (table !== campWeekDayTeachers) throw new Error("wrong table");
      const i = rows.findIndex((r) => r.teacherId === val.teacherId);
      const next = { teacherId: val.teacherId, startTime: val.startTime ?? null, endTime: val.endTime ?? null, rateMinor: val.rateMinor ?? 0 };
      if (i >= 0) rows[i] = next; else rows.push(next);
      writes.push(["upsert", val]);
    } }) }),
    update: (table: any) => ({ set: (patch: any) => ({ where: async () => {
      if (table === campWeekDays) { day.startTime = patch.startTime ? `${patch.startTime}:00` : day.startTime; day.endTime = patch.endTime ? `${patch.endTime}:00` : day.endTime; }
      writes.push([table === bookings ? "bookings" : table === campWeekDays ? "day" : "other", patch]);
    } }) }),
    delete: (table: any) => ({ where: async () => { writes.push(["delete", table === campWeekDayTeachers ? "teachers" : "other"]); } }),
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => {
    const n = writes.length, snap = rows.map((r) => ({ ...r }));
    try { return await fn(tx); } catch (e) { writes.length = n; rows.splice(0, rows.length, ...snap); throw e; }
  }) as any));
  spies.push(spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, _s: any, input: any) => { inserts.push(input); return `new-${inserts.length}`; }) as any));
  return { writes, inserts, rows };
}
const SENTENCE = (coach: string, s: string, e: string, ds: string, de: string) => `วันที่ ${CAMP_DAY} ครู ${coach} ตั้งเวลา ${s}-${e} อยู่นอกเวลาของวัน (${ds}-${de}) — ไม่ได้บันทึกอะไร`;

describe("🔴 TEST-089 Part 2 — the day's end moves under a coach's own hours", () => {
  test("THE REPRODUCTION: the day PATCHed to end at 14:00 WITH QACT's own 13:00–15:00 ⇒ refused, the exact sentence, NOTHING written, the sync never ran", async () => {
    const h = harness("10:00", "15:00", [stored(QACT)]);
    await expect(camp.updateWeekDay(W1, CAMP_DAY, { endTime: "14:00", teachers: [{ teacherId: QACT, startTime: "13:00", endTime: "15:00" }] }))
      .rejects.toMatchObject({ status: 400, message: SENTENCE("QACT", "13:00", "15:00", "10:00", "14:00") });
    expect(h.writes).toEqual([]);
    expect(h.inserts).toEqual([]);
  });
  test("ONLY the day's hours change (the front sends no `teachers[]`): the STORED own-hours coach is checked against the new window ⇒ refused, nothing written", async () => {
    const h = harness("10:00", "15:00", [stored(QACT, "13:00:00", "15:00:00")]);
    await expect(camp.updateWeekDay(W1, CAMP_DAY, { endTime: "14:00" })).rejects.toMatchObject({ status: 400, message: SENTENCE("QACT", "13:00", "15:00", "10:00", "14:00") });
    expect(h.writes).toEqual([]);
    expect(h.inserts).toEqual([]);
  });
  test("the START end: an own start BEFORE the day's start ⇒ refused", async () => {
    const h = harness("10:00", "15:00", []);
    await expect(camp.updateWeekDay(W1, CAMP_DAY, { teachers: [{ teacherId: MINT, startTime: "09:00", endTime: "11:00" }] })).rejects.toMatchObject({ status: 400, message: SENTENCE("มิ้นท์", "09:00", "11:00", "10:00", "15:00") });
    expect(h.writes).toEqual([]);
  });
});

describe("✅ what is still saved", () => {
  test("EQUAL ends are inside: own hours exactly the day's", async () => {
    const h = harness("10:00", "15:00", []);
    await expect(camp.updateWeekDay(W1, CAMP_DAY, { teachers: [{ teacherId: QACT, startTime: "10:00", endTime: "15:00" }] })).resolves.toBeTruthy();
    expect(h.writes.some((w) => w[0] === "upsert")).toBe(true);
  });
  test("the day AND a coach changed together into a valid pair ⇒ saved (judged against the day AFTER this save, not the old one)", async () => {
    const h = harness("10:00", "15:00", [stored(QACT, "13:00:00", "15:00:00")]);
    // the day moves to 08:00–12:00 and QACT is moved with it, in the same save
    await expect(camp.updateWeekDay(W1, CAMP_DAY, { startTime: "08:00", endTime: "12:00", teachers: [{ teacherId: QACT, startTime: "09:00", endTime: "11:00" }] })).resolves.toBeTruthy();
    expect(h.writes.some((w) => w[0] === "upsert")).toBe(true);
  });
  test("coaches on the DAY'S DEFAULT (no own times) are never refused — even when the day shrinks to nothing like their old hours", async () => {
    const h = harness("10:00", "15:00", [stored(QACT), stored(MINT)]);
    await expect(camp.updateWeekDay(W1, CAMP_DAY, { startTime: "10:00", endTime: "11:00" })).resolves.toBeTruthy();
    expect(h.writes.some((w) => w[0] === "day")).toBe(true);
  });
  test("the FIRST offender (the day's own order: start, then id) is the one named", async () => {
    const h = harness("10:00", "15:00", []);
    await expect(camp.updateWeekDay(W1, CAMP_DAY, { teachers: [{ teacherId: QACT, startTime: "13:00", endTime: "17:00" }, { teacherId: MINT, startTime: "08:00", endTime: "09:00" }] }))
      .rejects.toMatchObject({ message: SENTENCE("มิ้นท์", "08:00", "09:00", "10:00", "15:00") });
    expect(h.writes).toEqual([]);
  });
});

describe("🔑 by source", () => {
  const S = readFileSync(resolve(import.meta.dir, "camp.service.ts"), "utf8").replace(/\r\n/g, "\n");
  test("the check runs AFTER the coaches' write and BEFORE the sync, against the day's hours of THIS save; the sentence is the owner's", () => {
    expect(S).toContain("await assertOwnHoursInsideDay(tx, date, d.id, start, end);");
    const upd = S.slice(S.indexOf("export async function updateWeekDay("), S.indexOf("export async function listPackages("));
    expect(upd.indexOf("await setDayTeachers(")).toBeLessThan(upd.indexOf("await assertOwnHoursInsideDay("));
    expect(upd.indexOf("await assertOwnHoursInsideDay(")).toBeLessThan(upd.indexOf("return syncCampDayRows("));
    expect(S).toContain("const bad = own.find((c) => c.start < dayStart || c.end > dayEnd);");
    expect(S).toContain("`วันที่ ${date} ครู ${coach} ตั้งเวลา ${bad.start}-${bad.end} อยู่นอกเวลาของวัน (${dayStart}-${dayEnd}) — ไม่ได้บันทึกอะไร`");
  });
});

// ═══════════════════ §B (Sober, 2026-10-11) — the WEEK-level door: `updateWeek` re-derives the un-edited days into the new window ═══════════════════
const D2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CAMP_DAY2 = isoPlus(CAMP_DAY, 1);
function weekHarness(days: Array<{ id: string; date: string; editedAt?: Date | null; coaches: Stored[] }>) {
  const writes: any[] = [];
  const inserts: any[] = [];
  const dayRow = (d: (typeof days)[number]) => ({ id: d.id, campWeekId: W1, date: d.date, startTime: "10:00:00", endTime: "15:00:00", editedAt: d.editedAt ?? null, teachers: d.coaches });
  spies.push(spyOn(db.query.campWeeks, "findFirst").mockImplementation((async () => ({ ...week, windowStart: "10:00:00", windowEnd: "15:00:00" })) as any));
  const tx: any = {
    query: {
      teacherLeaveDays: { findFirst: async () => undefined },
      campWeekDays: {
        findMany: async () => days.filter((d) => !d.editedAt).map(dayRow), // the real query is `edited_at IS NULL`
        findFirst: async ({ where }: any) => { let id: string | undefined; where({ id: "id" }, { eq: (_c: any, v: string) => { id = v; } }); const d = days.find((x) => x.id === id) ?? days[0]!; return { ...dayRow(d), week }; },
      },
      campWeekDayTeachers: { findMany: async ({ where }: any) => { let id: string | undefined; where({ campWeekDayId: "x" }, { eq: (_c: any, v: string) => { id = v; } }); return (days.find((d) => d.id === id)?.coaches ?? []).map((c) => ({ campWeekDayId: id, ...c })); } },
      teachers: { findFirst: async () => null, findMany: async () => Object.entries(NAMES).map(([id, nickname]) => ({ id, nickname, name: nickname })) },
      bookings: { findFirst: async () => null },
    },
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => { writes.push(["upsert"]); } }) }),
    update: (table: any) => ({ set: (patch: any) => ({ where: () => {
      writes.push([table === campWeekDays ? "day" : "week", patch]);
      const p: any = Promise.resolve();
      p.returning = async () => [{ ...week, ...patch }];
      return p;
    } }) }),
    delete: () => ({ where: async () => { writes.push(["delete"]); } }),
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => { const n = writes.length, m = inserts.length; try { return await fn(tx); } catch (e) { writes.length = n; inserts.length = m; throw e; } }) as any)); // an earlier valid day's sync has already inserted when a later day refuses: the real transaction takes it back, so does this one
  spies.push(spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: () => ({ groupBy: async () => [] }) }) })) as any)); // the DTO's day counts
  spies.push(spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, _s: any, input: any) => { inserts.push(input); return `new-${inserts.length}`; }) as any));
  return { writes, inserts };
}

describe("🔴 §B — the WEEK-level window change: the same rule, the same sentence, by the other door", () => {
  test("narrowing the week's window under a stored own-hours coach of a re-derived day ⇒ refused, the exact sentence naming THAT day, NOTHING written", async () => {
    const h = weekHarness([{ id: D1, date: CAMP_DAY, coaches: [stored(MINT)] }, { id: D2, date: CAMP_DAY2, coaches: [stored(QACT, "13:00:00", "15:00:00")] }]);
    await expect(camp.updateWeek(W1, { windowStart: "10:00", windowEnd: "14:00" })).rejects.toMatchObject({
      status: 400, message: `วันที่ ${CAMP_DAY2} ครู QACT ตั้งเวลา 13:00-15:00 อยู่นอกเวลาของวัน (10:00-14:00) — ไม่ได้บันทึกอะไร`,
    });
    expect(h.writes).toEqual([]);
    expect(h.inserts).toEqual([]);
  });
  test("two offending days ⇒ the EARLIER date is named, whatever order the days were read in", async () => {
    weekHarness([
      { id: D2, date: CAMP_DAY2, coaches: [stored(QACT, "13:00:00", "15:00:00")] },
      { id: D1, date: CAMP_DAY, coaches: [stored(MINT, "12:00:00", "15:00:00")] },
    ]);
    await expect(camp.updateWeek(W1, { windowStart: "10:00", windowEnd: "14:00" })).rejects.toMatchObject({ message: `วันที่ ${CAMP_DAY} ครู มิ้นท์ ตั้งเวลา 12:00-15:00 อยู่นอกเวลาของวัน (10:00-14:00) — ไม่ได้บันทึกอะไร` });
  });
  test("a window that still holds every coach (widened) ⇒ saved; coaches on the day's default are never refused", async () => {
    const h = weekHarness([{ id: D1, date: CAMP_DAY, coaches: [stored(QACT, "13:00:00", "15:00:00"), stored(MINT)] }]);
    await expect(camp.updateWeek(W1, { windowStart: "09:00", windowEnd: "16:00" })).resolves.toBeTruthy();
    expect(h.writes.some((w) => w[0] === "day")).toBe(true);
  });
  test("a day an admin EDITED BY HAND is not re-derived, so it is not judged by the week's window", async () => {
    weekHarness([{ id: D1, date: CAMP_DAY, coaches: [stored(MINT)] }, { id: D2, date: CAMP_DAY2, editedAt: new Date(), coaches: [stored(QACT, "13:00:00", "15:00:00")] }]);
    await expect(camp.updateWeek(W1, { windowStart: "10:00", windowEnd: "14:00" })).resolves.toBeTruthy();
  });
  test("by source: the week door asks the SAME function per re-derived day, after that day's writes and before its sync, in date order", () => {
    const S = readFileSync(resolve(import.meta.dir, "camp.service.ts"), "utf8").replace(/\r\n/g, "\n");
    const upd = S.slice(S.indexOf("export async function updateWeek("), S.indexOf("export async function deleteWeek("));
    expect(upd).toContain("await assertOwnHoursInsideDay(tx, d.date, d.id, ws, we);");
    expect(upd.indexOf("await setDayTeachers(")).toBeLessThan(upd.indexOf("await assertOwnHoursInsideDay("));
    expect(upd.indexOf("await assertOwnHoursInsideDay(")).toBeLessThan(upd.indexOf("await syncCampDayRows("));
    expect(upd).toContain("[...days].sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)))");
  });
});
