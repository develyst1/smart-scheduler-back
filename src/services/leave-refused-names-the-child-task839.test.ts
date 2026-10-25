// TASK-839 (REQ-131) — the admin alert «ผู้ปกครองแจ้งลาไม่สำเร็จ — อายุคอร์สไม่พอสำหรับคาบชดเชย» NAMES the child and the class date (dd-mm-yyyy), never «- · -».
// The cause: the sender passed the booking inside the payload only; `notifyAdmins`'s 3rd argument is the outbox row's `booking_id`, and the worker builds `{student} · {date}` from THAT row. Two fixes pinned by value through the REAL worker:
//   1. the call passes the booking as the 3rd argument; 2. a row queued BEFORE the fix (`booking_id` NULL, `payload.bookingId` set) is named too — for this kind only. Every other row is built exactly as before.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import * as lineClient from "../lib/line-client";
import * as lineLib from "../lib/line";
import * as adminLib from "../lib/line-admin";
import { contextBookingId, processOutboxOnce } from "./outbox.service";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const read = (f: string) => code(readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n"));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const BOOKING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bookingRow = { id: BOOKING, date: "2026-10-30", startTime: "10:00:00", endTime: "11:00:00", bookingType: "COURSE_PACKAGE", status: "CONFIRMED", otherTitle: null, student: { id: "s1", name: "น้องบี", nickname: null }, coStudent: null, teacher: { nickname: "Bank" }, additionalTeachers: [], subject: { name: "Inline Skate" }, rental: null };
const outboxRow = (over: any = {}) => ({ id: "o1", status: "PENDING", channel: "line", recipientType: "admin", recipientLineUserId: "U-admin", bookingId: null, attempts: 0, payload: { kind: "leave_refused_no_validity", bookingId: BOOKING }, ...over });

/** Run the REAL worker over `rows`; returns the texts it pushed. */
async function work(rows: any[]): Promise<string[]> {
  const pushed: string[] = [];
  const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => rows };
  spies.push(spyOn(db, "select").mockImplementation((() => chain) as any));
  spies.push(spyOn(db, "update").mockImplementation((() => ({ set: () => ({ where: async () => undefined }) })) as any));
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => bookingRow) as any));
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(lineClient, "pushMessage").mockImplementation((async (_to: string, msgs: any[]) => { pushed.push(msgs[0].text); }) as any));
  await processOutboxOnce();
  return pushed;
}

describe("🔴 the admin text names the child and the class date — by value through the real worker", () => {
  test("a row WITH `booking_id` (what the fixed sender writes) ⇒ the child's name and the date as dd-mm-yyyy, not «-»", async () => {
    const [text] = await work([outboxRow({ bookingId: BOOKING })]);
    expect(text).toContain("น้องบี");
    expect(text).toContain("30-10-2026");
    expect(text).not.toMatch(/- · -/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no raw ISO date
  });
  test("an OLD-shape row (`booking_id` NULL, `payload.bookingId` set) ⇒ named too", async () => {
    const [text] = await work([outboxRow({ bookingId: null })]);
    expect(text).toContain("น้องบี");
    expect(text).toContain("30-10-2026");
    expect(text).not.toMatch(/- · -/);
  });
  test("a row with NEITHER ⇒ still «- · -» (the dashes, no crash)", async () => {
    const [text] = await work([outboxRow({ bookingId: null, payload: { kind: "leave_refused_no_validity" } })]);
    expect(text).toContain("- · -");
  });
  test("the old-shape rule is for THIS kind only: another kind with a NULL `booking_id` and a `payload.bookingId` is built exactly as before (no class named)", async () => {
    const [text] = await work([outboxRow({ bookingId: null, payload: { kind: "makeup_past_expiry", bookingId: BOOKING, landedOn: "2026-11-02", expiry: "2026-11-01" } })]);
    expect(text).not.toContain("น้องบี");
    expect(text).not.toContain("30-10-2026");
  });
  test("a row that already has `booking_id` is built from IT, never from a different `payload.bookingId`", () => {
    expect(contextBookingId({ bookingId: "row-id", payload: { kind: "leave_refused_no_validity", bookingId: "payload-id" } })).toBe("row-id");
    expect(contextBookingId({ bookingId: null, payload: { kind: "leave_refused_no_validity", bookingId: "payload-id" } })).toBe("payload-id");
    expect(contextBookingId({ bookingId: null, payload: { kind: "leave_refused_no_validity" } })).toBeNull();
    expect(contextBookingId({ bookingId: null, payload: { kind: "teacher_assigned", bookingId: "payload-id" } })).toBeNull();
    expect(contextBookingId({ bookingId: null, payload: { kind: "leave_refused_no_validity", bookingId: 42 } })).toBeNull(); // the wrong type is not an id
    expect(contextBookingId({ bookingId: null, payload: null })).toBeNull();
  });
});

describe("🔴 the sender — the 3rd argument reaches the outbox row's `booking_id`", () => {
  test("`notifyAdmins(payload, exec, bookingId)` writes `bookingId` on EVERY admin row (the existing contract the fix relies on)", async () => {
    const rows: any[] = [];
    spies.push(spyOn(adminLib, "getAdminLineUserIds").mockImplementation((async () => ["U-1", "U-2"]) as any));
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { rows.push(o); return { status: "queued" } as any; }) as any));
    await adminLib.notifyAdmins({ kind: "leave_refused_no_validity", bookingId: BOOKING }, db, BOOKING);
    expect(rows.map((r) => r.bookingId)).toEqual([BOOKING, BOOKING]);
  });
  test("by source: the refusal's call passes the booking as the 3rd argument, once, before the reply; the payload keeps its own `bookingId`", () => {
    const W = read("src/services/line-webhook.service.ts");
    const at = W.indexOf("if (e?.code === LEAVE_NO_VALIDITY_CODE) {");
    const blk = W.slice(at, W.indexOf("return send(replyToken, [textReply(e?.message", at));
    expect(blk).toContain('await notifyAdmins({ kind: "leave_refused_no_validity", bookingId: b.id }, db, b.id);');
    expect(blk.match(/notifyAdmins\(/g)).toHaveLength(1);
    expect(blk.indexOf("notifyAdmins(")).toBeLessThan(blk.indexOf("send(replyToken"));
  });
  test("by source: the worker builds its context through ONE helper — the row's id first, the payload's only for this kind", () => {
    const O = read("src/services/outbox.service.ts");
    expect(O).toContain("const ctx = await bookingContext(contextBookingId(row));");
    expect(O).toContain('p.kind === "leave_refused_no_validity" && typeof p.bookingId === "string" && p.bookingId ? p.bookingId : null');
    expect(O).toContain("if (row.bookingId) return row.bookingId;");
  });
});
