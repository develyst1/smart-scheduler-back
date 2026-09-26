// TASK-513 — pause and resume, as a PAIR, on a CO-TAUGHT class, by value through the real `pauseBooking` / `resumeBooking`.
// A coach told a class stopped and never told it resumed is worse off than one told neither — so the pin is the pair.
// Only the database is faked (one row, recording writes); WHO the coaches are is THE predicate's answer (`teachersOfBooking`).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../db";
import { notificationOutbox } from "../db/schema";
import * as mappers from "../db/mappers";
import * as ownScope from "../lib/own-scope";
import * as sched from "./scheduler.service";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const B1 = "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1";
const T1 = "t1t1t1t1-0000-4000-8000-000000000001", T2 = "t2t2t2t2-0000-4000-8000-000000000002", T3 = "t3t3t3t3-0000-4000-8000-000000000003";

function world(status: string) {
  const row: any = { id: B1, status, date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", teacherId: T1, courseId: null, bookingType: "OTHER", groupId: null, teacher: { id: T1, lineUserId: "U-t1" } };
  const outbox: any[] = [];
  const tx: any = {
    query: { bookings: { findFirst: async () => row } },
    update: () => ({ set: (v: any) => ({ where: async () => { Object.assign(row, v); } }) }),
    insert: (t: any) => ({ values: async (v: any) => { if (t !== notificationOutbox) throw new Error("unexpected insert"); outbox.push(v); } }),
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(mappers, "toBookingDTO").mockImplementation(((r: any) => ({ id: r.id, status: r.status })) as any));
  // Ek (primary, linked) + Ple (additional, linked) + Mai (additional, NOT linked)
  spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => [{ id: T1, lineUserId: "U-t1" }, { id: T2, lineUserId: "U-t2" }, { id: T3, lineUserId: null }]) as any));
  return { row, outbox };
}
const sent = (outbox: any[]) => outbox.map((o) => [o.recipientType, o.recipientLineUserId, o.bookingId, o.payload.kind, o.status]);

describe("🔴 TASK-513 — a co-taught class STOPS and STARTS AGAIN: every linked coach hears BOTH", () => {
  test("🔑 the PAIR: pause ⇒ both linked coaches told it stopped · resume ⇒ the same two told it restarted · the unlinked coach: no row (AC-7) · no family", async () => {
    const w = world("CONFIRMED");
    const paused = await sched.pauseBooking(B1);
    expect(sent(w.outbox)).toEqual([
      ["teacher", "U-t1", B1, "booking_paused", "PENDING"],
      ["teacher", "U-t2", B1, "booking_paused", "PENDING"],
    ]);
    expect(paused.notification).toEqual({ channel: "line", status: "queued" }); // the primary's, as the response always reported
    w.outbox.length = 0;
    const resumed = await sched.resumeBooking(B1, { date: "2026-10-12", startTime: "10:00" });
    expect(sent(w.outbox)).toEqual([
      ["teacher", "U-t1", B1, "booking_resumed", "PENDING"],
      ["teacher", "U-t2", B1, "booking_resumed", "PENDING"],
    ]);
    expect(resumed.notification).toEqual({ channel: "line", status: "queued" });
    expect([paused.booking.status, resumed.booking.status]).toEqual(["PAUSED", "CONFIRMED"]);
  });

  test("the primary UNLINKED: the additional coaches are still told; the response's `notification` is null (it describes the primary)", async () => {
    const w = world("CONFIRMED");
    spies.pop()!.mockRestore();
    spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => [{ id: T1, lineUserId: null }, { id: T2, lineUserId: "U-t2" }]) as any));
    const paused = await sched.pauseBooking(B1);
    expect(sent(w.outbox)).toEqual([["teacher", "U-t2", B1, "booking_paused", "PENDING"]]);
    expect(paused.notification).toBeNull();
  });
});
