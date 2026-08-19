// TASK-152 (REQ-049 AC-4) — a leave must always leave a trace. Found live on sid: with no admin LINE-linked,
// `notifyAdmins` looped over an empty list and enqueued NOTHING — no send and no record that a send was due.
// These tests use a stub exec (no DB) and assert the shape of what gets written.
import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { notifyAdmins } = await import("./line-admin");

/** Minimal Drizzle stand-in: records every inserted outbox row and serves the configured admin ids. */
function stubExec(adminIds: string[] | undefined) {
  const inserted: any[] = [];
  const exec = {
    query: {
      appSettings: {
        findFirst: async () => (adminIds === undefined ? undefined : { key: "line_admin_user_ids", value: adminIds }),
      },
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
