// TASK-522 (owner ruling: "a seat's coaches are the group's coaches") — `teachersOfBooking` resolves the CLASS first (a seat ⇒ its
// group row; anything else ⇒ itself), then asks THE predicate about that row. By value, over a small world whose two reads are
// answered from the rendered SQL's own parameters — and through a REAL producer (the cancel notice) for the two-seats case.
import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { teachersOfBooking } from "../lib/own-scope";
import * as sched from "./scheduler.service";

const dialect = new PgDialect();
// The Saturday group G, taught by Ek (primary) + Nok (recorded on the GROUP row). Ploy's and Mew's SEATS ride it. P is a private class.
const ROWS: Record<string, { groupId: string | null }> = { G: { groupId: null }, S1: { groupId: "G" }, S2: { groupId: "G" }, P: { groupId: null } };
const COACHES: Record<string, Array<{ id: string; lineUserId: string | null }>> = {
  G: [{ id: "ek", lineUserId: "U-ek" }, { id: "nok", lineUserId: "U-nok" }],
  S1: [{ id: "ek", lineUserId: "U-ek" }], // what the SEAT row alone would answer (its own teacher_id) — the bug
  S2: [{ id: "ek", lineUserId: "U-ek" }],
  P: [{ id: "ek", lineUserId: "U-ek" }],
};
function world(coaches = COACHES) {
  const asked: string[] = [];
  const outbox: any[] = [];
  const exec: any = {
    select: () => ({ from: () => ({
      where: (cond: any) => ({ limit: async () => { const id = dialect.sqlToQuery(cond).params[0] as string; return ROWS[id] ? [ROWS[id]] : []; } }),
      innerJoin: async (_t: any, cond: any) => { const q = dialect.sqlToQuery(cond); const classId = q.params[0] as string; asked.push(classId); return coaches[classId] ?? []; },
    }) }),
    insert: () => ({ values: async (v: any) => { outbox.push(v); } }),
  };
  return { exec, asked, outbox };
}

describe("🔴 TASK-522 — a SEAT's coaches are its GROUP's coaches; every other row is unchanged", () => {
  test("🔑 Ploy's SEAT ⇒ the GROUP's coaches, Ek AND Nok (it was Ek alone: Nok, standing in that class, was never told)", async () => {
    const w = world();
    expect(await teachersOfBooking(w.exec, "S1")).toEqual(COACHES.G);
    expect(w.asked).toEqual(["G"]); // THE predicate was asked about the GROUP row
  });
  test("🚫 a PRIVATE session is unchanged: its own coaches, asked about itself", async () => {
    const w = world();
    expect(await teachersOfBooking(w.exec, "P")).toEqual(COACHES.P);
    expect(w.asked).toEqual(["P"]);
  });
  test("🚫 the GROUP row itself is unchanged: its own coaches", async () => {
    const w = world();
    expect(await teachersOfBooking(w.exec, "G")).toEqual(COACHES.G);
    expect(w.asked).toEqual(["G"]);
  });
  test("an unknown row (deleted between reads) falls back to itself — never a different class", async () => {
    const w = world();
    await teachersOfBooking(w.exec, "gone");
    expect(w.asked).toEqual(["gone"]);
  });
  test("📌 the join is still THE predicate (TASK-487/508), now on the resolved class id", async () => {
    let q: any = null;
    const exec = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ groupId: "G" }] }), innerJoin: async (_t: any, cond: any) => { q = dialect.sqlToQuery(cond); return []; } }) }) };
    await teachersOfBooking(exec, "S1");
    expect(q.sql).toBe('("bookings"."id" = $1 and ("bookings"."teacher_id" = "teachers"."id" or exists (select 1 from "booking_teachers" where ("booking_teachers"."booking_id" = "bookings"."id" and "booking_teachers"."teacher_id" = "teachers"."id"))))');
    expect(q.params).toEqual(["G"]);
  });
});

describe("🔑 TASK-522 — through a REAL producer: TWO seats cancelled ⇒ each coach hears TWICE, once per child (pinned as CORRECT)", () => {
  const cancel = (exec: any, seat: string) =>
    sched.sendClassCancelledToCoaches(exec, { id: seat, teacherId: "ek", bookingType: "SINGLE_SESSION", course: null, voucher: null }, { cancelReason: "CUSTOMER_CANCELLED", note: null });
  test("Ploy's and Mew's seats cancelled ⇒ 4 rows: Ek and Nok for Ploy's seat, Ek and Nok for Mew's — each row names ITS seat, so each message is about ITS child", async () => {
    const w = world();
    await cancel(w.exec, "S1");
    await cancel(w.exec, "S2");
    expect(w.outbox.map((o) => [o.recipientLineUserId, o.bookingId, o.payload.kind])).toEqual([
      ["U-ek", "S1", "class_cancelled_teacher"], ["U-nok", "S1", "class_cancelled_teacher"],
      ["U-ek", "S2", "class_cancelled_teacher"], ["U-nok", "S2", "class_cancelled_teacher"],
    ]);
    expect(w.outbox.every((o) => o.recipientType === "teacher")).toBe(true); // 🚫 never the family on this path
  });
  test("an UNLINKED group coach is a SKIPPED row (recorded, not delivered) — as everywhere else", async () => {
    const w = world({ ...COACHES, G: [{ id: "ek", lineUserId: "U-ek" }, { id: "nok", lineUserId: null }] });
    await cancel(w.exec, "S1");
    expect(w.outbox.map((o) => [o.recipientLineUserId, o.status])).toEqual([["U-ek", "PENDING"], [null, "SKIPPED"]]);
  });
});
