// TASK-569 — the first-booking re-count must not undo a PERSON's extension. Decided from the RECORD (the actor); the yield is
// itself recorded. REQ-110 item 3 does not ship without this.
import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { prepareVoucherBooking } from "./scheduler.service";
import { voucherExpiry } from "../lib/voucher";

type Rec = { voucherId: string; fromDate: string; toDate: string; actor: string | null };
/** A voucher, its live-booking state and its expiry RECORD — the re-count's whole world; every write is kept. */
const world = (o: { expiryDate: string; liveBooking?: boolean; records?: Rec[] }) => {
  const v = { id: "v1", studentId: "s1", totalHours: 10, usedHours: 0, expiryDate: o.expiryDate, endedAt: null }; // the row as READ (a snapshot, as from the DB)
  const stored = { expiryDate: o.expiryDate }; // what the table holds after the writes
  const records = [...(o.records ?? [])];
  const writes: Array<[string, string, any]> = [];
  const exec = {
    query: {
      vouchers: { findFirst: async () => v },
      bookings: { findFirst: async () => (o.liveBooking ? { id: "b-live" } : undefined) },
      voucherExpiryChanges: {
        findFirst: async (q: any) => {
          // THE service's own where, evaluated: the voucher AND "an actor is set"
          const conds: any[] = [q.where({ voucherId: "voucherId", actor: "actor" }, { and: (...a: any[]) => a, eq: (c: string, val: unknown) => ({ c, val }), isNotNull: (c: string) => ({ c, notNull: true }) })].flat();
          return records.find((r: any) => conds.every((k) => (k.notNull ? r[k.c] != null : r[k.c] === k.val)));
        },
      },
    },
    update: (t: any) => ({ set: (patch: any) => ({ where: async () => { writes.push(["update", getTableName(t), patch]); Object.assign(stored, patch); } }) }),
    insert: (t: any) => ({ values: async (row: any) => { writes.push(["insert", getTableName(t), row]); records.push(row); } }),
  };
  return { exec, v: stored, writes, records };
};

describe("🔴 TASK-569 — BOTH directions", () => {
  test("🔑 a NORMAL voucher's first booking: re-counted from the booking date exactly as before, and that move recorded as the system", async () => {
    const { exec, v, writes } = world({ expiryDate: "2026-12-30" }); // the sale-day placeholder
    await prepareVoucherBooking(exec, "v1", "2026-10-05", "s1");
    const counted = voucherExpiry(10, "2026-10-05");
    expect(v.expiryDate).toBe(counted);
    expect(writes).toEqual([
      ["update", "vouchers", { expiryDate: counted }],
      ["insert", "voucher_expiry_changes", { voucherId: "v1", fromDate: "2026-12-30", toDate: counted, actor: null }],
    ]);
  });
  test("a record written only by the SYSTEM (an earlier re-count) is not a person — the re-count still runs", async () => {
    const { exec, v } = world({ expiryDate: "2027-04-05", records: [{ voucherId: "v1", fromDate: "2026-12-30", toDate: "2027-04-05", actor: null }] });
    await prepareVoucherBooking(exec, "v1", "2026-11-02", "s1");
    expect(v.expiryDate).toBe(voucherExpiry(10, "2026-11-02"));
  });
  test("🔑 an EXTENDED voucher SURVIVES a full cancel-and-rebook: the person's date is KEPT, and the yield is RECORDED (from = to, the system)", async () => {
    // history: sale → first booking re-count (system) → the admin extends to 2027-06-30 → every booking later cancelled
    const { exec, v, writes } = world({
      expiryDate: "2027-06-30",
      records: [
        { voucherId: "v1", fromDate: "2026-12-30", toDate: "2027-04-05", actor: null },
        { voucherId: "v1", fromDate: "2027-04-05", toDate: "2027-06-30", actor: "admin-dong" },
      ],
    });
    await prepareVoucherBooking(exec, "v1", "2026-11-02", "s1"); // the rebook — no live booking, so the re-count would fire
    expect(v.expiryDate).toBe("2027-06-30"); // ✅ the extension survives
    expect(writes).toEqual([["insert", "voucher_expiry_changes", { voucherId: "v1", fromDate: "2027-06-30", toDate: "2027-06-30", actor: null }]]);
  });
  test("a voucher with a LIVE booking is not re-counted at all (unchanged) — no write, no record", async () => {
    const { exec, writes } = world({ expiryDate: "2027-04-05", liveBooking: true, records: [{ voucherId: "v1", fromDate: "2027-04-05", toDate: "2027-06-30", actor: "admin-dong" }] });
    await prepareVoucherBooking(exec, "v1", "2026-11-02", "s1");
    expect(writes).toEqual([]);
  });
  test("the kept date still GATES: a rebook after the person's (earlier) date is refused as expired — the person's date is the date", async () => {
    const { exec } = world({ expiryDate: "2026-10-31", records: [{ voucherId: "v1", fromDate: "2027-04-05", toDate: "2026-10-31", actor: "admin-dong" }] });
    await expect(prepareVoucherBooking(exec, "v1", "2026-11-02", "s1")).rejects.toMatchObject({ status: 400 });
  });
});
