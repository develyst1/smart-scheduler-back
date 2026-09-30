// TASK-582 (REQ-110 item 2, the owner 2026-09-30: "for FUTURE dates the new act REPLACES the old auto-cancel — leave means one
// thing") — THE ADVANCE-LEAVE ACT, the writer TASK-561's inert gate was waiting for.
//   🔑 THE FORK (`isAdvanceLeave`, one place, used by `reportOwnLeave`): a date STRICTLY AFTER today ⇒ record the day + list its
//   live classes, 🚫 cancel nothing, tell nobody · today or the past ⇒ the old cancel, byte-for-byte what it was.
//   The ACTOR: the owner ruled the act, not a new actor ⇒ the narrowest reading: the SAME door and identity as before
//   (`POST /teachers/me/leave`, a LINKED teacher, their own day). No admin door, no new key.
//   Removable: lifting deletes that one leave row — restores nothing, cancels nothing.
//   And the gate goes LIVE: the row this act writes is the row THE reader finds — proven through one shared store.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import * as sched from "../services/scheduler.service";
import * as lineLib from "./line";
import { ApiException } from "./http";
import { isAdvanceLeave, liftAdvanceLeave, recordAdvanceLeave } from "./teacher-leave";
import { DEV_USER } from "../middleware/auth";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); delete process.env.SKIP_AUTH; });
const TODAY = "2026-10-01";
const today = () => setSystemTime(new Date(`${TODAY}T10:00:00+07:00`));
const ME = "11111111-1111-4111-8111-111111111111";
const dialect = new PgDialect();
const paramsOf = (cond: any) => dialect.sqlToQuery(cond).params;
const trip = (what: string) => () => { throw new Error(`TASK-582 tripwire: ${what}`); };
/** Everything the advance act must NOT do, made loud: a booking read-for-write, a transaction, an update, a message. */
const forbidCancelPath = () => {
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation(trip("the advance act read bookings the way the cancel does") as any));
  spies.push(spyOn(db, "transaction").mockImplementation(trip("the advance act opened a transaction") as any));
  spies.push(spyOn(db, "update").mockImplementation(trip("the advance act updated a row") as any));
  const sent: any[] = [];
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { sent.push(o); return { status: "queued" } as any; }) as any));
  return sent;
};
/** The leave table as an in-memory store: the act's INSERT and the lift's DELETE land here, and THE reader reads it. */
const store = () => {
  const rows: Array<{ id: string; teacherId: string; date: string; reason: string | null; createdBy: string | null }> = [];
  const listed = [{ id: "b-1", date: "2026-10-21", startTime: "10:00:00", endTime: "11:00:00", status: "CONFIRMED", bookingType: "PRIVATE" }];
  const exec: any = {
    insert: (t: any) => ({ values: (v: any) => ({ onConflictDoNothing: () => ({ returning: async () => {
      expect(getTableName(t)).toBe("teacher_leave_days");
      if (rows.some((r) => r.teacherId === v.teacherId && r.date === v.date)) return []; // the unique index
      const row = { id: `l-${rows.length + 1}`, ...v }; rows.push(row); return [row];
    } }) }) }),
    delete: (t: any) => ({ where: (cond: any) => ({ returning: async () => {
      expect(getTableName(t)).toBe("teacher_leave_days");
      const [teacherId, date] = paramsOf(cond);
      const gone = rows.filter((r) => r.teacherId === teacherId && r.date === date);
      for (const g of gone) rows.splice(rows.indexOf(g), 1);
      return gone.map((g) => ({ id: g.id }));
    } }) }),
    select: () => ({ from: (t: any) => ({ where: () => ({ orderBy: async () => (getTableName(t) === "bookings" ? listed : []) }) }) }),
    query: {
      teacherLeaveDays: { findFirst: async (q: any) => {
        const asked: Record<string, unknown> = {};
        const pairs = [q.where(new Proxy({}, { get: (_t, k) => String(k) }), { and: (...a: any[]) => a.flat(), eq: (c: string, v: unknown) => [[c, v]] })].flat(3);
        for (let i = 0; i < pairs.length; i += 2) asked[pairs[i] as string] = pairs[i + 1];
        return rows.find((r) => r.teacherId === asked.teacherId && r.date === asked.date);
      } },
      teachers: { findFirst: async () => ({ id: ME, nickname: "Ek", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME" }) },
      bookings: { findFirst: async () => undefined }, // the make-up's slot check: every slot free
    },
  };
  return { rows, listed, exec };
};

describe("🔑 THE FORK — named once (`isAdvanceLeave`), both sides pinned", () => {
  test("strictly AFTER today ⇒ advance · today ⇒ NOT (the day has begun: the cancel, which tells the families, is the honest act) · the past ⇒ not", () => {
    expect([isAdvanceLeave("2026-09-30", TODAY), isAdvanceLeave(TODAY, TODAY), isAdvanceLeave("2026-10-02", TODAY), isAdvanceLeave("2026-10-21", TODAY)]).toEqual([false, false, true, true]);
  });
  test("🔴 FUTURE side, by value: the day RECORDED (who, which day, why, by whom) and its live classes LISTED — 🚫 nothing cancelled, no transaction, nobody told", async () => {
    today();
    const sent = forbidCancelPath();
    const s = store();
    spies.push(spyOn(db, "insert").mockImplementation(s.exec.insert));
    spies.push(spyOn(db, "select").mockImplementation(s.exec.select));
    const r = await sched.reportOwnLeave(ME, { date: "2026-10-21", reason: "ธุระ" }, "coach-ek");
    expect(r).toEqual({ mode: "advance", cancelled: 0, bookingIds: [], familiesNotified: 0, leave: { date: "2026-10-21", reason: "ธุระ" }, alreadyRecorded: false, bookings: s.listed });
    expect(s.rows).toEqual([{ id: "l-1", teacherId: ME, date: "2026-10-21", reason: "ธุระ", createdBy: "coach-ek" }]);
    expect(sent).toEqual([]);
  });
  test("the future side, recorded twice ⇒ not an error: the FIRST record stands (its reason and author), the list returned again", async () => {
    today();
    forbidCancelPath();
    const s = store();
    spies.push(spyOn(db, "insert").mockImplementation(s.exec.insert));
    spies.push(spyOn(db, "select").mockImplementation(s.exec.select));
    spies.push(spyOn(db.query.teacherLeaveDays, "findFirst").mockImplementation(s.exec.query.teacherLeaveDays.findFirst));
    await sched.reportOwnLeave(ME, { date: "2026-10-21", reason: "ธุระ" }, "coach-ek");
    const again: any = await sched.reportOwnLeave(ME, { date: "2026-10-21", reason: "เปลี่ยนใจ" }, "someone");
    expect([again.alreadyRecorded, again.leave, s.rows.length]).toEqual([true, { date: "2026-10-21", reason: "ธุระ" }, 1]);
  });
  test("the future side with `sessionIds` (they pick classes to CANCEL) ⇒ 400 in words, NOTHING written — never silently ignored", async () => {
    today();
    forbidCancelPath();
    spies.push(spyOn(db, "insert").mockImplementation(trip("wrote a leave row") as any));
    const e: any = await sched.reportOwnLeave(ME, { date: "2026-10-21", sessionIds: ["22222222-2222-4222-8222-222222222222"], reason: "ธุระ" }, null).catch((x) => x);
    expect([e.status, e.message]).toEqual([400, "ลาล่วงหน้าเป็นการปิดทั้งวัน — ไม่ต้องเลือกคาบ คาบที่มีอยู่แล้วจะแสดงให้แอดมินจัดการ"]); // 📋 DRAFT
  });
  const cancelSide = async (date: string) => {
    today();
    spies.push(spyOn(db, "insert").mockImplementation(trip("the cancel side wrote a leave row") as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => [{ id: "b-9", date, status: "PENDING", bookingType: "PRIVATE", courseId: null, teacherId: ME, startTime: "15:00:00", additionalTeachers: [], seats: [] }]) as any));
    const writes: any[] = [];
    spies.push(spyOn(db, "transaction").mockImplementation((async (cb: any) => cb({ update: (t: any) => ({ set: (p: any) => ({ where: async () => { writes.push([getTableName(t), p]); } }) }) })) as any));
    const r = await sched.reportOwnLeave(ME, { date, reason: "ป่วย" }, "coach-ek");
    return { r, writes };
  };
  test("🔴 TODAY side, by value: UNCHANGED — the class CANCELLED with TEACHER_LEAVE, the old response shape (no `mode`), no leave row", async () => {
    const { r, writes } = await cancelSide(TODAY);
    expect(r).toEqual({ cancelled: 1, bookingIds: ["b-9"], familiesNotified: 0 });
    expect(writes).toEqual([["bookings", { status: "CANCELLED", note: "ป่วย", cancelReason: "TEACHER_LEAVE" }]]);
  });
  test("🔴 PAST side, by value: UNCHANGED (the same cancel) — the new act never records history", async () => {
    const { r, writes } = await cancelSide("2026-09-29");
    expect([r, writes.length]).toEqual([{ cancelled: 1, bookingIds: ["b-9"], familiesNotified: 0 }, 1]);
  });
  test("the writer refuses a non-future date on its own (defence in depth — the fork already routes today and the past away)", async () => {
    today();
    const e: any = await recordAdvanceLeave(store().exec, ME, { date: TODAY, reason: "x" }, null).catch((x) => x);
    expect([e.status, e.message]).toEqual([400, "ลาล่วงหน้าได้เฉพาะวันหลังจากวันนี้"]); // 📋 DRAFT
  });
});

describe("🔴 THE GATE, LIVE — the row this act writes is the row THE reader finds (one shared store); lifting it stops the block and nothing else", () => {
  test("recorded ⇒ a NEW booking with that teacher that day is refused · the make-up SKIPS that week · lifted ⇒ both as if it never was", async () => {
    today();
    const s = store();
    await recordAdvanceLeave(s.exec, ME, { date: "2026-10-08", reason: "ธุระ" }, "coach-ek");
    // Seam A — every insert / move / swap / co-teacher door calls it (the closed set is TASK-561's derived pin, still green)
    const refused: any = await sched.assertTeacherBookable(s.exec, ME, "2026-10-08").catch((x) => x);
    expect([refused.status, refused.code]).toEqual([409, "TEACHER_ON_LEAVE"]);
    await expect(sched.assertTeacherBookable(s.exec, ME, "2026-10-15")).resolves.toMatchObject({ id: ME }); // another day: untouched
    // Seam B — the automatic make-up passes over the leave week (never refused)
    expect(await sched.findFreeExtensionDate(s.exec, ME, "10:00:00", "2026-10-01")).toBe("2026-10-15");
    // LIFT — the leave row gone; nothing else in the store or anywhere was written
    expect(await liftAdvanceLeave(s.exec, ME, "2026-10-08")).toEqual({ lifted: "2026-10-08" });
    expect(s.rows).toEqual([]);
    await expect(sched.assertTeacherBookable(s.exec, ME, "2026-10-08")).resolves.toMatchObject({ id: ME });
    expect(await sched.findFreeExtensionDate(s.exec, ME, "10:00:00", "2026-10-01")).toBe("2026-10-08");
  });
  test("lifting RESTORES nothing and CANCELS nothing: it deletes one leave row (by teacher AND date) and touches no booking; not recorded ⇒ 404", async () => {
    today();
    const s = store();
    await recordAdvanceLeave(s.exec, ME, { date: "2026-10-08", reason: null as any }, null);
    await recordAdvanceLeave(s.exec, "someone-else", { date: "2026-10-08", reason: null as any }, null);
    spies.push(spyOn(db, "delete").mockImplementation(s.exec.delete));
    for (const m of ["update", "insert", "transaction"] as const) spies.push(spyOn(db as any, m).mockImplementation(trip(`the lift called db.${m}`) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation(trip("the lift read bookings") as any));
    expect(await sched.liftOwnLeave(ME, "2026-10-08")).toEqual({ lifted: "2026-10-08" });
    expect(s.rows.map((r) => r.teacherId)).toEqual(["someone-else"]); // only MY row
    const e: any = await sched.liftOwnLeave(ME, "2026-10-08").catch((x) => x);
    expect([e.status, e.message]).toEqual([404, "ไม่พบวันลาล่วงหน้านี้"]); // 📋 DRAFT
  });
});

describe("⚖️ THE ACTOR — the narrowest reading: the SAME door, key and identity as before; a LINKED teacher, their OWN day", () => {
  const call = (method: string, path: string, body?: unknown) =>
    ((globalThis as any).__app as { fetch: (r: Request) => Promise<Response> }).fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  test("through the ROOT app: a linked account reaches its own list and lift with `me`; an UNLINKED account (e.g. an admin) ⇒ 403 SCOPE_TEACHER on all three; a bad date ⇒ 400", async () => {
    (globalThis as any).__app = (await import("../index")).default;
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    spies.push(spyOn(sched, "ownLeaveDays").mockImplementation((async (me: string) => { calls.push(["list", me]); return [{ date: "2026-10-21", reason: "ธุระ" }]; }) as any));
    spies.push(spyOn(sched, "liftOwnLeave").mockImplementation((async (me: string, date: string) => { calls.push(["lift", me, date]); return { lifted: date }; }) as any));
    spies.push(spyOn(sched, "reportOwnLeave").mockImplementation((async () => { calls.push(["record"]); return {}; }) as any));
    const saved = DEV_USER.teacherId;
    try {
      (DEV_USER as any).teacherId = null; // unlinked
      for (const [m, p, b] of [["GET", "/teachers/me/leave"], ["DELETE", "/teachers/me/leave/2026-10-21"], ["POST", "/teachers/me/leave", { date: "2026-10-21", reason: "ธุระ" }]] as const) {
        const r = await call(m, p, b);
        expect({ p: `${m} ${p}`, status: r.status, code: ((await r.json()) as any).error?.code }).toEqual({ p: `${m} ${p}`, status: 403, code: "SCOPE_TEACHER" });
      }
      expect(calls).toEqual([]);
      (DEV_USER as any).teacherId = ME; // linked
      expect(await (await call("GET", "/teachers/me/leave")).json()).toEqual({ items: [{ date: "2026-10-21", reason: "ธุระ" }] });
      expect(await (await call("DELETE", "/teachers/me/leave/2026-10-21")).json()).toEqual({ lifted: "2026-10-21" });
      expect((await call("DELETE", "/teachers/me/leave/21-10-2026")).status).toBe(400);
      expect(calls).toEqual([["list", ME], ["lift", ME, "2026-10-21"]]);
    } finally { (DEV_USER as any).teacherId = saved; }
  });
});
void ApiException;
