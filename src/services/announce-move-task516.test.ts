// TASK-516 (owner ruling: "ย้ายคาบแจ้งทั้งคู่") — a MOVED class is announced to EVERY coach and to THE FAMILY; nothing else that an
// edit can do announces anything. By value through the REAL `moveBooking` over one in-memory row (the transaction's writes judged
// by what they set), the recipients from the shared rules (spied at their boundary), and the words by BYTES (✅ approved, TASK-529).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import * as sched from "./scheduler.service";
import * as ownScope from "../lib/own-scope";
import * as familyLink from "../lib/family-link";
import { formatOutboxMessage } from "../lib/line-message";
import { isRealMove } from "../lib/class-move";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

type W = { row: any; outbox: any[]; writes: string[]; reassigned: number; asked: Array<Array<string | null>> };
function world(over: Record<string, unknown> = {}, opts: { coaches?: any[]; family?: string[]; seats?: any[] } = {}): W {
  const w: W = {
    row: { id: "B1", status: "CONFIRMED", date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", teacherId: "t1", studentId: "s1", coStudentId: null,
      courseId: null, voucherId: null, bookingType: "SINGLE_SESSION", groupId: null, note: "n", campWeekDayId: null, ...over },
    outbox: [], writes: [], reassigned: 0, asked: [],
  };
  const withRels = () => ({ ...w.row, course: null, voucher: null });
  const tx: any = {
    query: { bookings: { findFirst: async () => withRels(), findMany: async () => opts.seats ?? [] } },
    update: (t: any) => ({ set: (v: any) => ({ where: async () => { w.writes.push(getTableName(t)); if (getTableName(t) === "bookings") Object.assign(w.row, v); } }) }),
    insert: (t: any) => ({ values: async (v: any) => { if (getTableName(t) !== "notification_outbox") throw new Error(`unexpected insert into ${getTableName(t)}`); w.outbox.push(v); } }),
  };
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => ({ ...w.row })) as any));
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(sched, "assertBookingCourseWritable").mockImplementation((async () => {}) as any));
  spies.push(spyOn(sched, "assertTeacherBookable").mockImplementation((async () => {}) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
  spies.push(spyOn(sched, "loadBookingDTO").mockImplementation((async () => ({ id: "B1" })) as any));
  spies.push(spyOn(sched, "sendTeacherReassigned").mockImplementation((async () => { w.reassigned++; }) as any));
  spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => opts.coaches ?? [{ id: "t1", lineUserId: "U-ek" }, { id: "t2", lineUserId: "U-nok" }]) as any));
  spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async (_e: any, ids: any) => { w.asked.push(ids); return opts.family ?? ["U-mom"]; }) as any));
  return w;
}
const moves = (w: W) => w.outbox.filter((o) => String(o.payload.kind).startsWith("class_moved"));
const A = { date: "2026-10-05", startTime: "10:00", endTime: "11:00" };

describe("🔴 TASK-516 — a real MOVE is announced to every coach AND the family, with FROM and TO", () => {
  test("🔑 by value: a DATE move ⇒ one row per coach (Ek, Nok) + the family's — each carrying the old slot and the new", async () => {
    const w = world();
    await sched.moveBooking("B1", { date: "2026-10-12" });
    const to = { date: "2026-10-12", startTime: "10:00", endTime: "11:00" };
    expect(moves(w).map((o) => [o.recipientType, o.recipientLineUserId, o.payload.kind])).toEqual([
      ["teacher", "U-ek", "class_moved_teacher"], ["teacher", "U-nok", "class_moved_teacher"], ["parent", "U-mom", "class_moved_parent"],
    ]);
    for (const o of moves(w)) expect([o.payload.from, o.payload.to, o.bookingId]).toEqual([A, to, "B1"]);
  });
  test("a TIME move alone fires too (the end follows the start)", async () => {
    const w = world();
    await sched.moveBooking("B1", { startTime: "14:00" });
    expect(moves(w)[0]!.payload.to).toEqual({ date: "2026-10-05", startTime: "14:00", endTime: "15:00" });
  });
  test("🚫 NOT a move ⇒ nothing new: a note · a rate · a subject · the SAME slot spelt differently (`10:00` vs `10:00:00`)", async () => {
    for (const input of [{ note: "bring skates" }, { subjectId: "sub-2" }, { startTime: "10:00" }, { date: "2026-10-05" }] as any[]) {
      for (const s of spies.splice(0)) s.mockRestore();
      const w = world();
      await sched.moveBooking("B1", input);
      expect({ input, sent: w.outbox }).toEqual({ input, sent: [] });
    }
    for (const s of spies.splice(0)) s.mockRestore();
    const w = world({ courseId: "c1" });
    await sched.moveBooking("B1", { classRateMinor: 45000 });
    expect(w.outbox).toEqual([]);
  });
  test("🚫 a TEACHER change alone still sends only what it sends today (the reassignment pair) — no move notice", async () => {
    const w = world();
    await sched.moveBooking("B1", { teacherId: "t9" });
    expect([w.reassigned, moves(w)]).toEqual([1, []]);
  });
  test("🚫 a PENDING class was never announced ⇒ its move announces nothing", async () => {
    const w = world({ status: "PENDING" });
    await sched.moveBooking("B1", { date: "2026-10-12" });
    expect(w.outbox).toEqual([]);
  });
  test("an EXTENDED make-up (on the coach's and family's schedule) IS announced", async () => {
    const w = world({ status: "EXTENDED" });
    await sched.moveBooking("B1", { date: "2026-10-12" });
    expect(moves(w).length).toBe(3);
  });
  test("🔑 TWO moves in a row ⇒ a CHAIN: A→B then B→C — each message true on its own (FROM is snapshotted per move, never read at send)", async () => {
    const w = world();
    await sched.moveBooking("B1", { date: "2026-10-12" });
    await sched.moveBooking("B1", { date: "2026-10-19" });
    const ek = moves(w).filter((o) => o.recipientLineUserId === "U-ek").map((o) => [o.payload.from.date, o.payload.to.date]);
    expect(ek).toEqual([["2026-10-05", "2026-10-12"], ["2026-10-12", "2026-10-19"]]);
  });
  test("unlinked recipients ⇒ SKIPPED rows, recorded not delivered — a coach with no link, a family with no linked account", async () => {
    const w = world({}, { coaches: [{ id: "t1", lineUserId: null }], family: [] });
    await sched.moveBooking("B1", { date: "2026-10-12" });
    expect(moves(w).map((o) => [o.recipientType, o.recipientLineUserId, o.status])).toEqual([["teacher", null, "SKIPPED"], ["parent", null, "SKIPPED"]]);
  });
  test("💰 it only ANNOUNCES: the move writes the booking row and outbox rows — no course, voucher or credit is touched", async () => {
    const w = world();
    await sched.moveBooking("B1", { date: "2026-10-12" });
    expect(w.writes).toEqual(["bookings"]);
    expect(w.row.status).toBe("CONFIRMED");
  });
});

describe("✅ TASK-529 — the WORDS, APPROVED by the owner: BYTE-pinned (the house block is the NEW slot; `Was :` appended)", () => {
  const CTX = { studentName: "มะขิด", subject: "Freeskate", coach: "Ek, Nok" };
  const payload = (kind: string) => ({ kind, bookingType: "SINGLE_SESSION", size: null, from: A, to: { date: "2026-10-12", startTime: "14:00", endTime: "15:00" } }) as any;
  const COACH = [
    "CLASS MOVED / ย้ายคาบ ‼️",
    "Student : มะขิด",
    "Program : Freeskate 1 HR",
    "Date : 12-10-2026",
    "Time : 14:00-15:00",
    "Coach : Ek, Nok",
    "Was : 05-10-2026 10:00-11:00",
  ].join("\n");
  const FAMILY_BODY = ["Student : มะขิด", "Program : Freeskate 1 HR", "Date : 12-10-2026", "Time : 14:00-15:00", "Was : 05-10-2026 10:00-11:00"];
  test("the COACH's copy — the approved bytes, IDENTICAL in TH and EN (the house stamp)", () => {
    expect(formatOutboxMessage(payload("class_moved_teacher"), CTX as any, "TH", "teacher")).toBe(COACH);
    expect(formatOutboxMessage(payload("class_moved_teacher"), CTX as any, "EN", "teacher")).toBe(COACH);
  });
  test("the FAMILY's copy — the approved bytes in both languages; no Coach line, no reason", () => {
    expect(formatOutboxMessage(payload("class_moved_parent"), CTX as any, "TH", "parent")).toBe(["📅 ย้ายคาบเรียน:", ...FAMILY_BODY].join("\n"));
    expect(formatOutboxMessage(payload("class_moved_parent"), CTX as any, "EN", "parent")).toBe(["📅 CLASS MOVED:", ...FAMILY_BODY].join("\n"));
  });
  test("🔑 deliberately mixed, BOTH halves pinned: the family's TITLE follows the chat language, its LABELS stay English", () => {
    const th = formatOutboxMessage(payload("class_moved_parent"), CTX as any, "TH", "parent").split("\n");
    const en = formatOutboxMessage(payload("class_moved_parent"), CTX as any, "EN", "parent").split("\n");
    expect([th[0], en[0]]).toEqual(["📅 ย้ายคาบเรียน:", "📅 CLASS MOVED:"]); // the title differs by language…
    expect(th.slice(1)).toEqual(en.slice(1)); // …the labelled lines do not
    expect(th.slice(1).map((l) => l.split(" : ")[0])).toEqual(["Student", "Program", "Date", "Time", "Was"]);
  });
  test("`Was :` is ONE appended line, LAST (where cancel puts Reason / Note), and it is the OLD slot — the block is the NEW one", () => {
    for (const [kind, who] of [["class_moved_teacher", "teacher"], ["class_moved_parent", "parent"]] as const) {
      const lines = formatOutboxMessage(payload(kind), CTX as any, "TH", who).split("\n");
      expect(lines.filter((l) => l.startsWith("Was : "))).toEqual(["Was : 05-10-2026 10:00-11:00"]);
      expect(lines.at(-1)).toBe("Was : 05-10-2026 10:00-11:00");
      expect(lines).toContain("Date : 12-10-2026");
    }
  });
  test("📌 `Was` is always present from the producer (`announceMove` builds `from` from the pre-move row's NOT NULL date/start) — only a hand-made partial payload loses it, and then the LINE goes, never a bare `Was :`", () => {
    const S = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(S).toContain("from: { date: before.date, startTime: hhmm(before.startTime), endTime: hhmm(before.endTime) },");
    const out = formatOutboxMessage({ kind: "class_moved_parent", from: { date: "2026-10-05" } } as any, CTX as any, "EN", "parent");
    expect(out.startsWith("📅 CLASS MOVED:")).toBe(true); // a poor message, never NO message (the walker's finding)
    expect(out).not.toContain("Was");
  });
});

describe("📌 the rule and the second door", () => {
  test("`isRealMove`: date or start time changed; the same time spelt twice is not a move", () => {
    expect(isRealMove({ date: "2026-10-05", startTime: "10:00:00" }, { date: "2026-10-05", startTime: "10:00" })).toBe(false);
    expect(isRealMove({ date: "2026-10-05", startTime: "10:00:00" }, { date: "2026-10-06", startTime: "10:00:00" })).toBe(true);
    expect(isRealMove({ date: "2026-10-05", startTime: "10:00:00" }, { date: "2026-10-05", startTime: "10:30:00" })).toBe(true);
  });
  test("the PLAN EDITOR's move calls the SAME sender inside its transaction (so a dry-run rolls the notice back with it)", () => {
    const S = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n");
    const edit = S.slice(S.indexOf("export async function applyPlanChange("));
    expect(edit).toContain("await announceMove(tx, b.id, b);");
    expect(edit.indexOf("await announceMove(tx, b.id, b);")).toBeLessThan(edit.indexOf('return await finalize({ change: "move" as const, bookingId: b.id });'));
  });
});

// ───────────────────────── TASK-516 addendum — a CANCELLED seat's family is not the class's family (the ONE household rule) ─────────────────────────
describe("🔴 TASK-516 addendum — the household rule drops CANCELLED seats; which notices change audience, each by value", () => {
  const seats = [
    { id: "S1", studentId: "kid-live", status: "CONFIRMED" },
    { id: "S2", studentId: "kid-gone", status: "CANCELLED" }, // left the group before this act
  ];
  const askedFor = () => {
    const asked: Array<Array<string | null>> = [];
    spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async (_e: any, ids: any) => { asked.push(ids); return ["U-live-mom"]; }) as any));
    return asked;
  };
  const txWithSeats = (list: any[]) => ({ query: { bookings: { findMany: async () => list } }, insert: () => ({ values: async () => {} }) });

  test("1️⃣ a GROUP MOVE (`moveBooking`): only the families of LIVE seats — the cancelled seat's family is not told", async () => {
    const w = world({ bookingType: "GROUP", studentId: null }, { seats });
    await sched.moveBooking("B1", { date: "2026-10-12" });
    expect(w.asked).toEqual([["kid-live"]]);
  });

  test("2️⃣ the family CANCEL notice (admin's group cancel · teacher's own leave · the series cancel-all — one rule): live seats only", async () => {
    const asked = askedFor();
    await sched.classCancelledFamilyAccounts(txWithSeats([]), { id: "G", status: "CONFIRMED", bookingType: "GROUP", seats } as any, "CUSTOMER_CANCELLED");
    expect(asked).toEqual([["kid-live"]]);
  });

  test("⚠️ …which is WHY the admin's group cancel passes the seats read BEFORE its cascade: re-read after it, every seat is CANCELLED and NO family would be told", async () => {
    const asked = askedFor();
    const afterCascade = seats.map((s) => ({ ...s, status: "CANCELLED" }));
    expect(await sched.classCancelledFamilyAccounts(txWithSeats(afterCascade), { id: "G", status: "CONFIRMED", bookingType: "GROUP" } as any, null)).toBeNull();
    expect(asked).toEqual([]);
    // …and the admin path reads them first, then cascades, then tells the families it read:
    const S = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n");
    const c = S.slice(S.indexOf('} else if (action === "cancel") {'), S.indexOf('} else if (action === "sick-leave"'));
    expect(c.indexOf("const seatsBefore =")).toBeLessThan(c.indexOf("await cancelSeatsOfGroup(tx, current.id"));
    expect(c).toContain("await sendClassCancelledToFamilies(tx, { ...current, seats: seatsBefore }, enumReason ?? null);");
    // …and the other two cancel callers already read their seats BEFORE cancelling (the series `seriesRows` loads them; the own-leave `mine`)
    const O = readFileSync(resolve(import.meta.dir, "other-series.service.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(O.indexOf("const rows = await seriesRows(tx, key);")).toBeLessThan(O.indexOf("seatsCancelled += await cancelSeatsOfGroup("));
  });

  test("🚫 a PRIVATE / DUO row's audience is unchanged: its two children", async () => {
    const asked = askedFor();
    await sched.classCancelledFamilyAccounts(txWithSeats([]), { id: "P", status: "CONFIRMED", bookingType: "COURSE_PACKAGE", studentId: "a", coStudentId: "b" } as any, null);
    expect(asked).toEqual([["a", "b"]]);
  });
});
