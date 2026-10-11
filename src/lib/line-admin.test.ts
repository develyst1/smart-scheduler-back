// TASK-152 (REQ-049 AC-4) — a leave must always leave a trace. Found live on sid: with no admin LINE-linked,
// `notifyAdmins` looped over an empty list and enqueued NOTHING — no send and no record that a send was due.
// These tests use a stub exec (no DB) and assert the shape of what gets written.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const lineAdmin = await import("./line-admin");
const { notifyAdmins } = lineAdmin;

/** Minimal Drizzle stand-in: records every inserted outbox row and serves the configured admin ids. */
// 🔻 TASK-725 — `users` rows (`lineUserId`, `disabledAt`): the recipients are the ACTIVE linked web users ∪ the legacy list. The `where` callback our code passes is
// run with fake operators over these rows, so "linked and not disabled" is evaluated, not merely present.
type UserRow = { lineUserId: string | null; disabledAt: Date | null };
const ops = {
  and: (...c: Array<(r: any) => boolean>) => (r: any) => c.every((p) => p(r)),
  isNotNull: (col: string) => (r: any) => r[col] != null,
  isNull: (col: string) => (r: any) => r[col] == null,
};
const columns = new Proxy({}, { get: (_t, k) => k });
function stubExec(adminIds: string[] | undefined, userRows: UserRow[] = []) {
  const inserted: any[] = [];
  const exec = {
    query: {
      appSettings: {
        findFirst: async () => (adminIds === undefined ? undefined : { key: "line_admin_user_ids", value: adminIds }),
      },
      users: { findMany: async (q: any) => userRows.filter(q.where(columns, ops)).map((r) => ({ lineUserId: r.lineUserId })) },
    },
    insert: () => ({ values: async (row: any) => void inserted.push(row) }),
  };
  return { exec, inserted };
}

const payload = { kind: "sick_leave", studentName: "น้องทดสอบ", via: "line" };

describe("notifyAdmins — never silent (TASK-152)", () => {
  test("ZERO configured admins → exactly ONE visible SKIPPED row, with the real reason", async () => {
    const { exec, inserted } = stubExec([]);
    await notifyAdmins(payload, exec, "booking-1");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      recipientType: "admin",
      recipientLineUserId: null,
      bookingId: "booking-1",
      status: "SKIPPED",
      error: "no admin recipient configured", // not the generic "no line userId" — the environment is the fault
    });
  });

  test("no settings row at all behaves the same — a fresh environment is loud, not empty", async () => {
    const { exec, inserted } = stubExec(undefined);
    await notifyAdmins(payload, exec, "booking-2");
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe("SKIPPED");
  });

  test("one admin → one real PENDING row, and NO extra skipped row", async () => {
    const { exec, inserted } = stubExec(["U-admin-1"]);
    await notifyAdmins(payload, exec, "booking-3");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      recipientType: "admin",
      recipientLineUserId: "U-admin-1",
      bookingId: "booking-3",
      status: "PENDING",
    });
  });

  test("several admins → one row each, unchanged behaviour", async () => {
    const { exec, inserted } = stubExec(["U-1", "U-2", "U-3"]);
    await notifyAdmins(payload, exec);
    expect(inserted).toHaveLength(3);
    expect(inserted.every((r) => r.status === "PENDING")).toBe(true);
    expect(inserted.map((r) => r.recipientLineUserId)).toEqual(["U-1", "U-2", "U-3"]);
  });

  test("the booking is carried on the skipped row too, so the trace points at the leave", async () => {
    const { exec, inserted } = stubExec([]);
    await notifyAdmins(payload, exec, "booking-9");
    expect(inserted[0].bookingId).toBe("booking-9");
    expect(inserted[0].payload).toMatchObject({ kind: "sick_leave" });
  });
});

// ───────────── TASK-725 — the recipients are the ACTIVE LINKED web users ∪ the LEGACY list ─────────────
const U = (lineUserId: string | null, disabled = false): UserRow => ({ lineUserId, disabledAt: disabled ? new Date() : null });
describe("🔴 TASK-725 — who receives admin notices (by value)", () => {
  test("a linked ACTIVE user ✓ · a linked DISABLED user ✗ · a legacy id ✓ · an unlinked user ✗", async () => {
    const { exec } = stubExec(["U-legacy"], [U("U-active"), U("U-disabled", true), U(null)]);
    expect(await lineAdmin.getAdminLineUserIds(exec)).toEqual(["U-legacy", "U-active"]);
  });
  test("disable = notices OFF, enable = ON, with no second switch: the same user, only `disabledAt` differs", async () => {
    expect(await lineAdmin.getAdminLineUserIds(stubExec([], [U("U-x", true)]).exec)).toEqual([]);
    expect(await lineAdmin.getAdminLineUserIds(stubExec([], [U("U-x", false)]).exec)).toEqual(["U-x"]);
  });
  test("an account in BOTH lists counts ONCE, and the legacy-first order readers have always seen is unchanged", async () => {
    const { exec } = stubExec(["U-1", "U-both"], [U("U-both"), U("U-2")]);
    expect(await lineAdmin.getAdminLineUserIds(exec)).toEqual(["U-1", "U-both", "U-2"]);
  });
  test("`notifyAdmins` writes one row per recipient of the union, and a linked-only environment is NOT 'no admin configured'", async () => {
    const { exec, inserted } = stubExec([], [U("U-linked")]);
    await notifyAdmins(payload, exec, "booking-725");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ recipientType: "admin", recipientLineUserId: "U-linked", status: "PENDING" });
    const none = stubExec([], [U("U-off", true)]);
    await notifyAdmins(payload, none.exec);
    expect(none.inserted[0]).toMatchObject({ status: "SKIPPED", error: "no admin recipient configured" }); // every linked user disabled ⇒ the loud skipped row, not silence
  });
  test("🔑 removing a LEGACY id rebuilds the legacy list from the LEGACY list only — it must never copy a linked user's id into it", async () => {
    const writes: unknown[] = [];
    const { exec } = stubExec(["U-1", "U-2"], [U("U-linked")]);
    (exec as any).insert = () => ({ values: (v: any) => ({ onConflictDoUpdate: async () => void writes.push(v.value) }) });
    await lineAdmin.removeAdminLineUserId("U-1", exec);
    expect(writes).toEqual([["U-2"]]);
  });
  test("🔴 nothing ADDS to the legacy list any more: `addAdminLineUserId` is gone, and `removeAdminLineUserId` is the ONLY writer of the setting", async () => {
    expect(lineAdmin).not.toHaveProperty("addAdminLineUserId");
    const SRC = readFileSync(resolve(import.meta.dir, "line-admin.ts"), "utf8").replace(/\r\n/g, "\n");
    expect((SRC.match(/\.insert\(appSettings\)/g) ?? []).length).toBe(1);
    const at = SRC.indexOf("export async function removeAdminLineUserId(");
    expect(at).toBeGreaterThan(-1);
    expect(SRC.indexOf(".insert(appSettings)")).toBeGreaterThan(at); // …and that one insert is inside the remover
    expect(SRC.indexOf(".insert(appSettings)")).toBeLessThan(SRC.indexOf("export async function notifyAdmins("));
  });
});
