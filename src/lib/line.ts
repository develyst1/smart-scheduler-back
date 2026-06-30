// LINE push via the notification outbox. We never call the LINE API inline:
// a row is written here (atomic with the booking change), and a worker delivers
// + retries it later. No recipient userId → SKIPPED (so the FE can warn).
//
// ⚠️ Uses the LINE Messaging API (Official Account push). LINE Notify is dead
// (service ended 2025-03-31). Tokens stay server-side only.

import { db } from "../db";
import { notificationOutbox } from "../db/schema";

export type NotifyResult = {
  channel: "line";
  status: "queued" | "skipped";
  reason?: string;
};

export async function enqueueLine(
  opts: {
    recipientType: "teacher" | "parent" | "student" | "admin";
    recipientLineUserId?: string | null;
    bookingId?: string;
    payload: unknown;
  },
  // pass a transaction to keep the outbox write atomic with the state change
  exec: any = db,
): Promise<NotifyResult> {
  if (!opts.recipientLineUserId) {
    await exec.insert(notificationOutbox).values({
      recipientType: opts.recipientType,
      recipientLineUserId: null,
      bookingId: opts.bookingId ?? null,
      payload: opts.payload as any,
      status: "SKIPPED",
      error: "no line userId",
    });
    return { channel: "line", status: "skipped", reason: "ผู้รับยังไม่ผูก LINE userId" };
  }

  await exec.insert(notificationOutbox).values({
    recipientType: opts.recipientType,
    recipientLineUserId: opts.recipientLineUserId,
    bookingId: opts.bookingId ?? null,
    payload: opts.payload as any,
    status: "PENDING",
  });
  return { channel: "line", status: "queued" };
}
