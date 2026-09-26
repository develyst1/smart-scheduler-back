// TASK-497 — undoing a mistaken ATTENDANCE (TASK-258's door: `updateBookingStatus(id, "sick-leave")` on an ATTENDED row) now returns
// the session to CONFIRMED — never a SICK_LEAVE the family never took — through the SAME writes as the check-in Undo, and records
// the event whose KIND is the truth. By value, through the real service, over a fake transaction whose UPDATEs are judged by their
// REAL rendered SQL (so the guard and the floors are exercised, not assumed). Every other behaviour of the branch pinned unchanged.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import * as sched from "./scheduler.service";
import * as salePost from "../lib/sale-post";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
const dialect = new PgDialect();
const camel = (s: string) => s.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
const KEY: Record<string, string> = { bookings: "bookings", course_packages: "courses", vouchers: "vouchers" };

type W = { bookings: any[]; courses: any[]; vouchers: any[]; inserts: Array<{ table: string; v: any }>; holds: Array<[string, string]>; reversed: string[] };
const B1 = "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1";
function run(over: Record<string, unknown> = {}, opts: { stale?: any } = {}): W {
  const w: W = {
    bookings: [{ id: B1, status: "ATTENDED", date: "2026-09-20", startTime: "10:00:00", teacherId: "t1", studentId: "s1", courseId: "c1", voucherId: null, bookingType: "COURSE_PACKAGE",
      note: "old note", plannedAtCreation: false, leaveCharged: null, checkinSource: "staff", checkinChannel: "staff", checkinActor: "admin-kwan", campWeekDayId: null, ...over }],
    courses: [{ id: "c1", size: 4, usedSessions: 3, leaveUsed: 1 }],
    vouchers: [{ id: "v1", totalHours: 10, usedHours: 5 }],
    inserts: [], holds: [], reversed: [],
  };
  const withRels = (r: any) => r && ({ ...r, course: w.courses.find((c) => c.id === r.courseId) ?? null, voucher: w.vouchers.find((v) => v.id === r.voucherId) ?? null });
  const tx: any = {
    query: { bookings: { findFirst: async () => (opts.stale ? withRels(opts.stale) : withRels(w.bookings[0])) } },
    update: (t: any) => ({ set: (set: Record<string, unknown>) => ({ where: (cond: any) => {
      const { sql, params } = dialect.sqlToQuery(cond);
      if (!/^\(?("\w+"\."\w+" = \$\d+( and )?)+\)?$/.test(sql)) throw new Error(`unhandled WHERE: ${sql}`);
      const conds = [...sql.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)].map((m) => ({ col: camel(m[2]!), val: params[Number(m[3]) - 1] }));
      const rows = (w as any)[KEY[getTableName(t)]!] as any[];
      const hits = rows.filter((r) => conds.every((c) => r[c.col] === c.val));
      for (const r of hits) for (const [k, v] of Object.entries(set)) {
        if (v && typeof v === "object" && "queryChunks" in (v as object)) {
          const q = dialect.sqlToQuery(v as any).sql;
          if (/ \+ 1$/.test(q)) { r[k] = r[k] + 1; continue; } // an increment: a mutation that charges the quota must be SEEN by value, not crash
          if (!/^GREATEST\(".+?"\."\w+" - 1, 0\)$/.test(q)) throw new Error(`unhandled SQL in set: ${q}`);
          r[k] = Math.max(0, r[k] - 1);
        } else r[k] = v;
      }
      const out = hits.map((r) => ({ id: r.id }));
      return Object.assign(Promise.resolve(out), { returning: async () => out });
    } }) }),
    insert: (t: any) => ({ values: async (v: any) => { w.inserts.push({ table: getTableName(t), v }); } }),
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async (_t: any, id: string, _te: string, status: string) => { w.holds.push([id, status]); }) as any));
  spies.push(spyOn(sched, "loadBookingDTO").mockImplementation((async (_e: any, id: string) => ({ id })) as any));
  spies.push(spyOn(salePost, "reverseBookingSale").mockImplementation((async (id: string) => { w.reversed.push(id); return { posted: false } as any; }) as any));
  return w;
}
const STAFF = { channel: "staff" as const, actor: "admin-dong" };
const errOf = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return { status: e.status, code: e.code }; } return null; };

describe("🔴 TASK-497 — an undone ATTENDANCE is CONFIRMED again, through the shared writes, with a TRUE event", () => {
  test("🔑 by value (a STAFF mark on a course): CONFIRMED · the unit back · the note · the row's check-in cleared · ONE event `attendance` keeping the provenance · nothing else", async () => {
    const w = run();
    const out = await sched.updateBookingStatus(B1, "sick-leave", "marked the wrong child", false, undefined, STAFF);
    const b = w.bookings[0];
    expect([b.status, b.note, b.checkinSource, b.checkinChannel, b.checkinActor]).toEqual(["CONFIRMED", "marked the wrong child", null, null, null]);
    expect(b.leaveCharged).toBeNull(); // no leave was written, so no charge was recorded
    expect([w.courses[0].usedSessions, w.courses[0].leaveUsed]).toEqual([2, 1]); // 🔴 AC-2 the unit back · AC-4 the quota UNTOUCHED
    expect(w.inserts).toEqual([{ table: "booking_undos", v: {
      bookingId: B1, kind: "attendance", undoneBy: "admin-dong", reason: "marked the wrong child", priorStatus: "ATTENDED",
      priorCheckinChannel: "staff", priorCheckinActor: "admin-kwan", leaveRefunded: false, makeupCancelledId: null, expiryFrom: null, expiryTo: null,
    } }]); // 🚫 no outbox row (no message) · 🚫 no bookings row (no make-up) — the ONLY insert is the event
    expect(out.notification).toEqual({ channel: "line", status: "skipped", reason: "แก้ไขการเช็คชื่อ — ไม่ส่งข้อความ" });
    expect(w.reversed).toEqual([B1]); // AC-5..7 the sale reversal, AFTER the transaction (as before)
    expect(w.holds).toEqual([[B1, "CONFIRMED"]]); // 📌 named consequence: CONFIRMED HOLDS the coach's freelance hour (SICK_LEAVE released it)
  });

  test("🔑 the KIND is the truth: staff ⇒ attendance · the day-end's mark ⇒ attendance · a legacy row with no channel ⇒ attendance · a PARENT's check-in ⇒ checkin", async () => {
    const cases: Array<[string | null, string]> = [["staff", "attendance"], ["end-of-day", "attendance"], [null, "attendance"], ["checkin-qr", "checkin"], ["line", "checkin"], ["shopfront-qr", "checkin"]];
    for (const [channel, kind] of cases) {
      for (const s of spies.splice(0)) s.mockRestore();
      const w = run({ checkinChannel: channel });
      await sched.updateBookingStatus(B1, "sick-leave", undefined, false, undefined, STAFF);
      expect({ channel, kind: w.inserts[0]?.v.kind, status: w.bookings[0].status }).toEqual({ channel, kind, status: "CONFIRMED" });
    }
  });

  test("a VOUCHER hour comes back instead, floored (a voucher already at 0 stays 0)", async () => {
    let w = run({ courseId: null, voucherId: "v1", bookingType: "VOUCHER" });
    await sched.updateBookingStatus(B1, "sick-leave", undefined, false, undefined, STAFF);
    expect([w.vouchers[0].usedHours, w.courses[0].usedSessions]).toEqual([4, 3]);
    for (const s of spies.splice(0)) s.mockRestore();
    w = run({ courseId: null, voucherId: "v1", bookingType: "VOUCHER" });
    w.vouchers[0].usedHours = 0;
    await sched.updateBookingStatus(B1, "sick-leave", undefined, false, undefined, STAFF);
    expect(w.vouchers[0].usedHours).toBe(0);
  });

  test("🔑 the GUARD (now on this door too): a second request that read ATTENDED after the first committed touches ZERO rows, returns NOTHING twice, records nothing", async () => {
    const w = run();
    const stale = { ...w.bookings[0] }; // what the second request read
    await sched.updateBookingStatus(B1, "sick-leave", undefined, false, undefined, STAFF);
    for (const s of spies.splice(0)) s.mockRestore();
    const w2 = run({}, { stale });
    w2.bookings[0].status = "CONFIRMED"; w2.courses[0].usedSessions = 2; // the world after the first
    expect(await errOf(sched.updateBookingStatus(B1, "sick-leave", undefined, false, undefined, STAFF))).toEqual({ status: 409, code: "UNDO_ALREADY_CHANGED" });
    expect([w2.courses[0].usedSessions, w2.inserts]).toEqual([2, []]);
    expect(w.inserts.length).toBe(1);
  });
});
