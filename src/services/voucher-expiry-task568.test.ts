// TASK-568 (REQ-110 item 3) — a voucher's expiry can be extended, and EVERY move of it is recorded from day one (from · to ·
// actor · when). The governing rule: D8 existed because expiry moves went unrecorded.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { db } from "../db";
import * as svc from "./scheduler.service";
import { ROUTE_ACCESS } from "../lib/route-access";

const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const fnBody = (s: string, head: string) => { const a = s.indexOf(head); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf("\n}\n", a)); };
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const x of spies.splice(0)) x.mockRestore(); });

const V = { id: "v1", studentId: "s1", totalHours: 10, usedHours: 3, expiryDate: "2026-10-31", endedAt: null, endReason: null, createdAt: new Date("2026-08-01T00:00:00Z"), student: { id: "s1", name: "Mola", nickname: "โมล่า", crmLevel: 1 } };
const B = (id: string, date: string, status: string) => ({ id, date, status, startTime: "10:00:00", voucherId: "v1" });
/** The world the editor reads, and every write it makes (inside the one transaction). */
const arm = (voucher: any, rows: any[]) => {
  const writes: Array<[string, string, any]> = [];
  spies.push(spyOn(db.query.vouchers, "findFirst").mockImplementation((async () => voucher) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows) as any));
  const tx = {
    update: (t: any) => ({ set: (patch: any) => ({ where: async () => { writes.push(["update", getTableName(t), patch]); } }) }),
    insert: (t: any) => ({ values: async (v: any) => { writes.push(["insert", getTableName(t), v]); } }),
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  return writes;
};
const errOf = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return { status: e.status, code: e.code, message: e.message as string }; } return null; };

describe("🔴 TASK-568 — the edit: one date, and its RECORD in the same transaction", () => {
  test("🔑 by value: the voucher's expiry written AND a record row (from · to · the PERSON) — nothing else", async () => {
    const writes = arm(V, [B("b1", "2026-09-10", "ATTENDED"), B("b2", "2026-10-20", "CONFIRMED")]);
    const r: any = await svc.updateVoucherExpiry("v1", { expiryDate: "2026-12-31" }, "admin-dong");
    expect(writes).toEqual([
      ["update", "vouchers", { expiryDate: "2026-12-31" }],
      ["insert", "voucher_expiry_changes", { voucherId: "v1", fromDate: "2026-10-31", toDate: "2026-12-31", actor: "admin-dong" }],
    ]);
    expect(r.previousExpiryDate).toBe("2026-10-31");
  });
  test("an ALREADY-EXPIRED voucher IS extendable — that is what the feature is for", async () => {
    const writes = arm({ ...V, expiryDate: "2026-08-31" }, [B("b1", "2026-08-10", "ATTENDED")]);
    await svc.updateVoucherExpiry("v1", { expiryDate: "2026-11-30" }, "admin-dong");
    expect(writes.map((w) => w[1])).toEqual(["vouchers", "voucher_expiry_changes"]);
  });
  test("🔴 no actor ⇒ 401 ACTOR_REQUIRED, NOTHING written — a person's edit is never recorded as the system", async () => {
    const writes = arm(V, [B("b1", "2026-09-10", "ATTENDED")]);
    expect(await errOf(svc.updateVoucherExpiry("v1", { expiryDate: "2026-12-31" }, null))).toMatchObject({ status: 401, code: "ACTOR_REQUIRED" });
    expect(writes).toEqual([]);
  });
  test("ENDED ⇒ 409 VOUCHER_ENDED; NOT STARTED (no live booking — validity counts from the first) ⇒ 409 VOUCHER_NOT_STARTED; nothing written", async () => {
    let writes = arm({ ...V, endedAt: new Date() }, [B("b1", "2026-09-10", "ATTENDED")]);
    expect(await errOf(svc.updateVoucherExpiry("v1", { expiryDate: "2026-12-31" }, "admin-dong"))).toMatchObject({ status: 409, code: "VOUCHER_ENDED" });
    expect(writes).toEqual([]);
    for (const x of spies.splice(0)) x.mockRestore();
    writes = arm(V, [B("b1", "2026-09-10", "CANCELLED")]);
    const e = await errOf(svc.updateVoucherExpiry("v1", { expiryDate: "2026-12-31" }, "admin-dong"));
    expect([e?.status, e?.code, e?.message.includes("นับจากการจองครั้งแรก")]).toEqual([409, "VOUCHER_NOT_STARTED", true]);
    expect(writes).toEqual([]);
  });
  test("the SAME date ⇒ no record row (a no-op is not a change — the course record's own rule)", async () => {
    const writes = arm(V, [B("b1", "2026-09-10", "ATTENDED")]);
    await svc.updateVoucherExpiry("v1", { expiryDate: "2026-10-31" }, "admin-dong");
    expect(writes.filter((w) => w[0] === "insert")).toEqual([]);
  });
  test("the preview WRITES NOTHING and gives the PATCH's own warning (one answer, two callers): a booked session past the new date", async () => {
    const rows = [B("b1", "2026-09-10", "ATTENDED"), B("b2", "2026-10-20", "CONFIRMED")];
    const writes = arm(V, rows);
    const p: any = await svc.previewVoucherExpiry("v1", { expiryDate: "2026-10-15" });
    expect(writes).toEqual([]);
    const done: any = await svc.updateVoucherExpiry("v1", { expiryDate: "2026-10-15" }, "admin-dong");
    expect(p.expiryWarning).toEqual(done.expiryWarning);
    expect(JSON.stringify(p.expiryWarning)).toContain("b2");
  });
});

describe("🔴 TASK-568 — BOTH writers of a voucher's expiry record; the audience decided; the doors", () => {
  const S = code("src/services/scheduler.service.ts");
  test("the first booking's re-count is RECORDED as the system (actor null) — its value unchanged", async () => {
    const inserted: any[] = [];
    await svc.recordVoucherExpiryChange({ insert: () => ({ values: async (v: any) => { inserted.push(v); } }) }, { voucherId: "v1", from: "2026-11-30", to: "2026-12-14", actor: null });
    expect(inserted).toEqual([{ voucherId: "v1", fromDate: "2026-11-30", toDate: "2026-12-14", actor: null }]);
    const prep = fnBody(S, "async function prepareVoucherBooking(");
    expect(prep).toContain("expiryDate = voucherExpiry(v.totalHours, date);"); // how it is first set: unchanged (§3)
    expect(prep).toContain("await recordVoucherExpiryChange(exec, { voucherId, from: v.expiryDate, to: expiryDate, actor: null });");
    expect(prep.indexOf("set({ expiryDate })")).toBeLessThan(prep.indexOf("recordVoucherExpiryChange("));
  });
  test("🔕 nobody is told — DELIBERATELY, as the course's expiry edit tells nobody: no send in either editor", () => {
    for (const head of ["export async function updateVoucherExpiry(", "export async function updateCourseExpiry("]) {
      expect(fnBody(S, head)).not.toMatch(/enqueueLine|notifyAdmins|sendTo|\.notify/);
    }
  });
  test("the routes: preview · PATCH (the actor from the TOKEN) · the record — gated by the course-expiry key, as voucher cancel reuses course-cancel", () => {
    const api = code("src/routes/api.ts");
    expect(api).toContain('.patch("/vouchers/:id/expiry", zValidator("json", v.updateCourseExpiry), async (c) =>');
    expect(api).toContain('svc.updateVoucherExpiry(c.req.param("id"), c.req.valid("json"), actorOf(c))');
    expect(ROUTE_ACCESS["PATCH /vouchers/:id/expiry"]).toEqual(ROUTE_ACCESS["PATCH /courses/:id/expiry"]);
    expect(ROUTE_ACCESS["POST /vouchers/:id/expiry/preview"]).toEqual(ROUTE_ACCESS["POST /courses/:id/expiry/preview"]);
    expect(ROUTE_ACCESS["GET /vouchers/:id/expiry-history"]).toEqual(ROUTE_ACCESS["GET /courses/:id/expiry-history"]);
  });
});
