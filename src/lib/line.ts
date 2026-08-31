// LINE push via the notification outbox. We never call the LINE API inline:
// a row is written here (atomic with the booking change), and a worker delivers
// + retries it later. No recipient userId → SKIPPED (so the FE can warn).
//
// ⚠️ Uses the LINE Messaging API (Official Account push). LINE Notify is dead
// (service ended 2025-03-31). Tokens stay server-side only.

import { db } from "../db";
import { notificationOutbox } from "../db/schema";
import { pgErrorCode } from "./http";

export type NotifyResult = {
  channel: "line";
  /** `duplicate` is a success: this exact message was already queued (see `idempotencyKey`). */
  status: "queued" | "skipped" | "duplicate";
  reason?: string;
};

/**
 * Queue one LINE push.
 *
 * 🔴 **`idempotencyKey` may only be used OUTSIDE a transaction** (TASK-218). The duplicate case is detected by
 * letting the insert hit `notification_outbox_idempotency_uq` and swallowing the `23505` — and a swallowed
 * constraint error inside a transaction leaves that transaction **aborted**, so every later statement in it
 * fails. The caveat lives here, on the signature, rather than in a task file nobody opens: every `exec: tx`
 * caller passes no key, and the daily reminder — the only keyed caller — enqueues on the default connection.
 */
export async function enqueueLine(
  opts: {
    recipientType: "teacher" | "parent" | "student" | "admin";
    recipientLineUserId?: string | null;
    bookingId?: string;
    payload: unknown;
    /** TASK-152: why this row was skipped, when the reason isn't simply "this recipient has no LINE link". */
    skipReason?: string;
    /**
     * TASK-218 — send-once key for callers that can legitimately fire more than once for the same message,
     * mirroring the day-end sale's `rev:<bookingId>` (`lib/sale-post.ts`). A second insert with the same key
     * hits `notification_outbox_idempotency_uq` and returns `duplicate` instead of queueing a second push.
     *
     * ⚠️ **Never pass this together with a transactional `exec`** — see the note on the function above.
     */
    idempotencyKey?: string;
  },
  // pass a transaction to keep the outbox write atomic with the state change
  exec: any = db,
): Promise<NotifyResult> {
  if (!opts.recipientLineUserId) {
    // 🔴 A SKIPPED row NEVER carries the key. It records that we could not reach someone — not that they were
    // reminded — and claiming the key here would mean a parent who was unlinked at 07:00 and links LINE by
    // 08:15 is silently never sent to. That is the exact class of bug TASK-218 exists to remove.
    await exec.insert(notificationOutbox).values({
      recipientType: opts.recipientType,
      recipientLineUserId: null,
      bookingId: opts.bookingId ?? null,
      payload: opts.payload as any,
      status: "SKIPPED",
      error: opts.skipReason ?? "no line userId",
    });
    return { channel: "line", status: "skipped", reason: "ผู้รับยังไม่ผูก LINE userId" };
  }

  try {
    await exec.insert(notificationOutbox).values({
      recipientType: opts.recipientType,
      recipientLineUserId: opts.recipientLineUserId,
      bookingId: opts.bookingId ?? null,
      payload: opts.payload as any,
      status: "PENDING",
      idempotencyKey: opts.idempotencyKey ?? null,
    });
  } catch (e) {
    // Only for a KEYED send: swallowing 23505 on an unkeyed insert would hide a real constraint failure.
    if (opts.idempotencyKey && pgErrorCode(e) === "23505") {
      return { channel: "line", status: "duplicate", reason: opts.idempotencyKey };
    }
    throw e;
  }
  return { channel: "line", status: "queued" };
}
