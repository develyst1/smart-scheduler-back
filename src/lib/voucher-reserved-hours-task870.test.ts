// 🔻 TASK-870 (REQ-5008; ขวัญ ruled «B», 2026-11-08) — a voucher counts the sessions ALREADY BOOKED, and a check-in on an EMPTY voucher is REFUSED (409 VOUCHER_EXHAUSTED, nothing written). No database: the pure rule by value, the booking gate and the
// attend gate through fake executors, the DTO by value, the wiring (and the day-end's absence of a gate) by source. Each pin must fail when its line is removed (voucher-reserved-hours-task870.mutations.json).
import { afterAll, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { db } = await import("../db");
const vlib = await import("./voucher");
const svc = await import("../services/scheduler.service");
const leaveLib = await import("./teacher-leave");
const { toVoucherDTO } = await import("../db/mappers");
const { readSrc } = await import("./read-src");

const file = async (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const SVC = code(readSrc(await file("../services/scheduler.service.ts")));
const JOBS = code(readSrc(await file("../services/jobs.service.ts")));
const CHECKIN = code(readSrc(await file("../services/checkin.service.ts")));
const fnBody = (src: string, start: string, end: string) => { const a = src.indexOf(start); return src.slice(a, src.indexOf(end, a + 1)); };

const V = (o: Partial<{ totalHours: number; usedHours: number; expiryDate: string; endedAt: string | null }> = {}) => ({ totalHours: 5, usedHours: 0, expiryDate: "2027-06-01", endedAt: null, ...o });

describe("🔴 TASK-870 — the rule: available = total − used − reserved; the switch is ONE constant, REFUSE by default", () => {
  test("🔒 the default is REFUSE (ขวัญ «B»); the sentence is the approved «ชั่วโมงในวอยเชอร์หมดแล้ว»; the reserving statuses are the live set (PENDING · CONFIRMED · EXTENDED)", () => {
    expect(vlib.VOUCHER_EMPTY_CHECKIN).toBe("REFUSE");
    expect(vlib.VOUCHER_EMPTY_MESSAGE).toBe("ชั่วโมงในวอยเชอร์หมดแล้ว");
    expect([...vlib.VOUCHER_RESERVING_STATUSES]).toEqual(["PENDING", "CONFIRMED", "EXTENDED"]);
    for (const s of ["PENDING", "CONFIRMED", "EXTENDED"]) expect(vlib.isVoucherReserving(s)).toBe(true);
    for (const s of ["ATTENDED", "NO_SHOW", "SICK_LEAVE", "CANCELLED", "PAUSED", "PENDING_RESCHEDULE"]) expect(vlib.isVoucherReserving(s)).toBe(false);
  });
  test("voucherAvailable = total − used − reserved, never below 0; voucherRemaining stays the used-based display figure", () => {
    expect(vlib.voucherAvailable(V({ totalHours: 5, usedHours: 1 }), 2)).toBe(2);
    expect(vlib.voucherAvailable(V({ totalHours: 5, usedHours: 4 }), 3)).toBe(0);
    expect(vlib.voucherAvailable(V({ totalHours: 5, usedHours: 1 }), -4)).toBe(4);
    expect(vlib.voucherRemaining(V({ totalHours: 5, usedHours: 1 }))).toBe(4);
    expect(vlib.voucherStatus(V({ totalHours: 5, usedHours: 1 }), "2026-11-10")).toBe("ACTIVE"); // the status stays used-based (the SOM / list meaning does not shift)
    expect(vlib.voucherStatus(V({ totalHours: 5, usedHours: 4 }), "2026-11-10")).toBe("ACTIVE"); // one hour left is still ACTIVE, whatever is booked
    expect(vlib.voucherStatus(V({ totalHours: 5, usedHours: 5 }), "2026-11-10")).toBe("EXHAUSTED");
  });
  test("voucherUsable: 1 h left + 0 reserved ⇒ ok; 1 h left + 1 reserved ⇒ refused with the sentence; reserved defaults to 0 for the old callers; an ended voucher is still refused first", () => {
    expect(vlib.voucherUsable(V({ totalHours: 5, usedHours: 4 }), "2026-11-10", 0)).toEqual({ ok: true });
    expect(vlib.voucherUsable(V({ totalHours: 5, usedHours: 4 }), "2026-11-10", 1)).toEqual({ ok: false, reason: "ชั่วโมงในวอยเชอร์หมดแล้ว" });
    expect(vlib.voucherUsable(V({ totalHours: 5, usedHours: 4 }), "2026-11-10")).toEqual({ ok: true });
    expect(vlib.voucherUsable(V({ endedAt: "2026-11-01T00:00:00Z" }), "2026-11-10", 0).reason).toBe(vlib.VOUCHER_ENDED_MESSAGE);
    expect(vlib.voucherUsable(V({ expiryDate: "2026-11-01" }), "2026-11-10", 0)).toEqual({ ok: false, reason: "วอยเชอร์หมดอายุแล้ว" });
  });
  test("emptyVoucherCheckin: ALLOW while any hour is left; at used ≥ total it is the switch's value — REFUSE by default, WARN as the other value", () => {
    expect(vlib.emptyVoucherCheckin(V({ totalHours: 5, usedHours: 4 }))).toBe("ALLOW");
    expect(vlib.emptyVoucherCheckin(V({ totalHours: 5, usedHours: 5 }))).toBe("REFUSE");
    expect(vlib.emptyVoucherCheckin(V({ totalHours: 5, usedHours: 7 }))).toBe("REFUSE"); // an over-booked voucher of old
    expect(vlib.emptyVoucherCheckin(V({ totalHours: 5, usedHours: 5 }), "WARN")).toBe("WARN");
    expect(vlib.emptyVoucherCheckin(V({ totalHours: 5, usedHours: 4 }), "WARN")).toBe("ALLOW");
  });
});

describe("🔴 TASK-870 — the BOOKING gate (prepareVoucherBooking): the live bookings reserve hours", () => {
  /** an executor whose voucher has `used` of `total`, a prior booking (so no expiry re-count), and `rows` as the voucher's bookings (the fake ignores the where, as the real `inArray` is pinned by source) */
  const exec = (used: number, total: number, rows: Array<{ status: string }>) => ({
    query: {
      vouchers: { findFirst: async () => ({ id: "v1", studentId: "s1", totalHours: total, usedHours: used, expiryDate: "2027-06-01", endedAt: null }) },
      bookings: { findFirst: async () => ({ id: "prior" }), findMany: async () => rows },
      voucherExpiryChanges: { findFirst: async () => undefined },
    },
  });
  test("1 h left + 0 reserved ⇒ the booking is allowed", async () => {
    await expect(svc.prepareVoucherBooking(exec(4, 5, []), "v1", "2026-11-10", "s1")).resolves.toBeUndefined();
  });
  test("1 h left + 1 reserved (a CONFIRMED / PENDING / EXTENDED booking) ⇒ refused with the approved sentence", async () => {
    for (const status of ["CONFIRMED", "PENDING", "EXTENDED"]) await expect(svc.prepareVoucherBooking(exec(4, 5, [{ status }]), "v1", "2026-11-10", "s1")).rejects.toMatchObject({ status: 400, message: "ชั่วโมงในวอยเชอร์หมดแล้ว" });
  });
  test("a CANCELLED / leave / paused / already-delivered row does not reserve (it books nothing more)", async () => {
    const rows = ["CANCELLED", "SICK_LEAVE", "PAUSED", "ATTENDED", "NO_SHOW"].map((status) => ({ status }));
    await expect(svc.prepareVoucherBooking(exec(4, 5, rows), "v1", "2026-11-10", "s1")).resolves.toBeUndefined();
  });
  test("the reserved read is ONE query on this voucher's id and the live statuses, in the same executor (by source); the gate sits in prepareVoucherBooking only", () => {
    const P = fnBody(SVC, "export async function prepareVoucherBooking(", "/**\n * TASK-162");
    expect(P).toContain("and(eq(b.voucherId, voucherId), inArray(b.status, [...VOUCHER_RESERVING_STATUSES]))");
    expect(P).toContain("voucherUsable({ totalHours: v.totalHours, usedHours: v.usedHours, expiryDate }, date, reserved)");
  });
  test("🔑 moving / rescheduling / re-teaching a booked voucher session books NOTHING new: no door but the create path calls the gate, so a full voucher's booked session can still be moved", () => {
    expect(SVC.match(/prepareVoucherBooking\(/g)).toHaveLength(2); // the definition + the ONE call
    const create = fnBody(SVC, "    if (input.voucherId) {", "}");
    expect(create).toContain("await prepareVoucherBooking(tx, input.voucherId, input.date, studentId!);");
  });
  test("🔻 AMENDMENT 2 — the gate runs for ANY booking that carries a voucherId (a VOUCHER booking AND an อื่นๆ that deducts a voucher), not by booking type", () => {
    expect(SVC).toContain("    if (input.voucherId) {\n      await prepareVoucherBooking(tx, input.voucherId, input.date, studentId!);\n    }");
    expect(SVC).not.toContain('bookingType === "VOUCHER" && input.voucherId');
  });
  test("an OTHER booking with a voucher: 1 h left + 1 reserved ⇒ refused with the sentence; 1 left + 0 reserved ⇒ OK (the gate is the same function, whatever the booking type)", async () => {
    const e = (rows: Array<{ status: string }>) => ({ query: { vouchers: { findFirst: async () => ({ id: "v1", studentId: "s1", totalHours: 5, usedHours: 4, expiryDate: "2027-06-01", endedAt: null }) }, bookings: { findFirst: async () => ({ id: "prior" }), findMany: async () => rows }, voucherExpiryChanges: { findFirst: async () => undefined } } });
    await expect(svc.prepareVoucherBooking(e([{ status: "CONFIRMED" }]), "v1", "2026-11-10", "s1")).rejects.toMatchObject({ message: "ชั่วโมงในวอยเชอร์หมดแล้ว" });
    await expect(svc.prepareVoucherBooking(e([]), "v1", "2026-11-10", "s1")).resolves.toBeUndefined();
  });
  test("an OTHER booking WITH a voucher and NO student is refused by the existing «not this child's voucher» check (a voucher belongs to a child)", async () => {
    const e: any = { query: { vouchers: { findFirst: async () => ({ id: "v1", studentId: "s1", totalHours: 5, usedHours: 0, expiryDate: "2027-06-01", endedAt: null }) }, bookings: { findFirst: async () => ({ id: "prior" }), findMany: async () => [] }, voucherExpiryChanges: { findFirst: async () => undefined } } };
    await expect(svc.prepareVoucherBooking(e, "v1", "2026-11-10", null as any)).rejects.toMatchObject({ status: 400, message: "วอยเชอร์นี้ไม่ใช่ของนักเรียนที่เลือก" });
  });
  test("an OTHER booking with a voucher RESERVES an hour for the next VOUCHER booking: the reserved count has no booking-type filter (its where is voucher id + the live statuses only)", () => {
    const P = fnBody(SVC, "export async function prepareVoucherBooking(", "/**\n * TASK-162");
    expect(P).toContain("and(eq(b.voucherId, voucherId), inArray(b.status, [...VOUCHER_RESERVING_STATUSES]))");
    expect(P).not.toMatch(/bookingType/);
  });
  test("the other doors: the OTHER series creator passes no voucherId, and no update path writes `voucher_id` — so a move / edit of an OTHER row (even on a full voucher) can never reach the gate", async () => {
    const OS = code(readSrc(await file("../services/other-series.service.ts")));
    expect(OS).not.toMatch(/voucherId/);
    expect(SVC.match(/voucherId: input\.voucherId \?\? null/g)).toHaveLength(1); // the ONE writer of the column is the inserter
    expect(SVC).not.toMatch(/\.set\(\{[^}]*voucherId:/);
  });
});

describe("🔴 TASK-870 — the CHECK-IN gate: an empty voucher is REFUSED with nothing written (the manual attend AND every check-in path share this one door)", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterAll(() => { for (const s of spies) s.mockRestore(); });
  const done = () => { for (const s of spies.splice(0)) s.mockRestore(); };
  const run = async (voucher: { usedHours: number; totalHours: number } | null) => {
    const writes: string[] = [];
    const tx: any = {
      query: { bookings: { findFirst: async () => ({ id: "b1", status: "CONFIRMED", voucherId: voucher ? "v1" : null, voucher, courseId: null, course: null, studentId: "s1", coStudentId: null, teacherId: "t1", bookingType: voucher ? "VOUCHER" : "SINGLE_SESSION" }) } },
      update: () => { writes.push("update"); return { set: () => ({ where: () => ({ returning: async () => [{ usedHours: 99 }] }) }) }; },
      insert: () => { writes.push("insert"); return { values: async () => [] }; },
      delete: () => { writes.push("delete"); return { where: async () => [] }; },
    };
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any), spyOn(leaveLib, "assertNoCoachOnLeave").mockImplementation((async () => {}) as any));
    try { return { error: await svc.updateBookingStatus("b1", "attend").then(() => null, (e) => e), writes }; } finally { done(); }
  };
  test("the default: used ≥ total ⇒ 409 VOUCHER_EXHAUSTED with the approved sentence; NOTHING is written (no used_hours change, no status change, no attendance row)", async () => {
    const r = await run({ usedHours: 5, totalHours: 5 });
    expect(r.error).toMatchObject({ status: 409, code: "VOUCHER_EXHAUSTED", message: "ชั่วโมงในวอยเชอร์หมดแล้ว" });
    expect(r.writes).toEqual([]);
  });
  test("an over-booked voucher of old (used > total) is refused the same way", async () => {
    const r = await run({ usedHours: 7, totalHours: 5 });
    expect(r.error).toMatchObject({ code: "VOUCHER_EXHAUSTED" });
    expect(r.writes).toEqual([]);
  });
  test("a voucher with an hour left is NOT refused by the gate (the attend goes on to write)", async () => {
    const r = await run({ usedHours: 4, totalHours: 5 });
    expect(r.error?.code).not.toBe("VOUCHER_EXHAUSTED");
    expect(r.writes.length).toBeGreaterThan(0);
  });
  test("a booking with no voucher (a course session, a single) is never gated", async () => {
    const r = await run(null);
    expect(r.error?.code).not.toBe("VOUCHER_EXHAUSTED");
  });
  test("the gate sits BEFORE the first write of the attend, in the `attend` branch; WARN mode (the switch's other value) sets `voucherWarning` instead of throwing, and the response carries it only then", () => {
    const U = fnBody(SVC, "export async function updateBookingStatus(", "if (reverseSaleAfterCommit) await");
    const gate = U.indexOf('if (emptyAct === "REFUSE") throw conflict("VOUCHER_EXHAUSTED", VOUCHER_EMPTY_MESSAGE);');
    expect(gate).toBeGreaterThan(U.indexOf('} else if (action === "attend") {'));
    expect(gate).toBeLessThan(U.indexOf('.set({ status: "ATTENDED"'));
    expect(U).toContain('if (emptyAct === "WARN") voucherWarning = VOUCHER_EMPTY_MESSAGE;');
    expect(U).toContain("...(voucherWarning ? { voucherWarning } : {})");
  });
  test("the check-in service has no gate of its own: the token / LINE / shop-front paths all call updateBookingStatus('attend'), so the 409 reaches them with error.code = VOUCHER_EXHAUSTED (the envelope carries the ApiException's code)", () => {
    expect(CHECKIN).toContain('await updateBookingStatus(row.id, "attend", undefined, false, undefined, { channel: source })');
    expect(CHECKIN).not.toContain("VOUCHER_EXHAUSTED");
  });
  test("🔑 the DAY-END auto-attend never refuses: it has no gate (its deduction path does not call the empty-voucher rule)", () => {
    expect(JOBS).not.toMatch(/emptyVoucherCheckin|VOUCHER_EXHAUSTED|VOUCHER_EMPTY_CHECKIN/);
    expect(JOBS).toContain("usedHours: sql`${vouchers.usedHours} + 1`");
  });
});

describe("🔴 TASK-870 — the DTO: hoursReserved / hoursAvailable (additive)", () => {
  test("the voucher DTO: reserved = the live bookings; available = total − used − reserved; a single-row write (no bookings loaded) reads 0 reserved", () => {
    const v = { id: "v1", totalHours: 5, usedHours: 1, expiryDate: "2027-06-01", student: { id: "s1", name: "Kid", nickname: null }, endedAt: null };
    const withRows = toVoucherDTO({ ...v, bookings: [{ status: "CONFIRMED" }, { status: "PENDING" }, { status: "CANCELLED" }] });
    expect([withRows.hoursReserved, withRows.hoursAvailable, withRows.remaining]).toEqual([2, 2, 4]);
    expect([toVoucherDTO(v).hoursReserved, toVoucherDTO(v).hoursAvailable]).toEqual([0, 4]);
  });
  test("the list reads the reserved rows in the SAME query as the vouchers (the live statuses only), and the plan summary carries both numbers — by source", () => {
    expect(SVC).toContain("with: { student: true, bookings: { columns: { status: true }, where: (b, { inArray: inB }) => inB(b.status, [...VOUCHER_RESERVING_STATUSES]) } }");
    expect(SVC).toContain("hoursReserved: rows.filter((r: any) => isVoucherReserving(r.status)).length,");
    expect(SVC).toContain("hoursAvailable: voucherAvailable(voucher, rows.filter((r: any) => isVoucherReserving(r.status)).length),");
  });
});
