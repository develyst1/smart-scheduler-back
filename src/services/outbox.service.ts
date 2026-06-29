// LINE outbox worker (B.3). Reliable push: enqueueLine() writes a row; this worker
// delivers it via the Messaging API, retries transient failures, and records the
// outcome (SENT / FAILED) with an audit trail (attempts, error, sentAt).
//
// Deployment note: this runs in-process (started from index.ts) — a single worker.
// An `isRunning` guard prevents overlapping ticks. For multi-instance scale-out,
// switch the SELECT to `FOR UPDATE SKIP LOCKED`.

import { and, asc, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "../db";
import { notificationOutbox } from "../db/schema";
import { hhmm } from "../lib/time";
import { formatOutboxMessage, type MessageContext } from "../lib/line-message";
import { LinePushError, lineConfigured, pushMessage } from "../lib/line-client";

const MAX_ATTEMPTS = 5;
const BATCH = 20;

async function bookingContext(bookingId: string | null): Promise<MessageContext> {
  if (!bookingId) return {};
  const b = await db.query.bookings.findFirst({
    where: (x, { eq }) => eq(x.id, bookingId),
    with: { student: true, teacher: true, subject: true },
  });
  if (!b) return {};
  return {
    studentName: b.student?.name,
    teacherNickname: b.teacher?.nickname,
    subject: b.subject?.name,
    date: b.date,
    startTime: hhmm(b.startTime),
    endTime: hhmm(b.endTime),
  };
}

/** Process one batch of pending LINE rows. Returns a small summary for logging/tests. */
export async function processOutboxOnce(): Promise<{ sent: number; failed: number; retry: number }> {
  const rows = await db
    .select()
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.status, "PENDING"),
        eq(notificationOutbox.channel, "line"),
        isNotNull(notificationOutbox.recipientLineUserId),
        lt(notificationOutbox.attempts, MAX_ATTEMPTS),
      ),
    )
    .orderBy(asc(notificationOutbox.createdAt))
    .limit(BATCH);

  let sent = 0,
    failed = 0,
    retry = 0;

  for (const row of rows) {
    const ctx = await bookingContext(row.bookingId);
    const text = formatOutboxMessage(row.payload as any, ctx);
    const attempts = row.attempts + 1;
    try {
      await pushMessage(row.recipientLineUserId!, [{ type: "text", text }]);
      await db
        .update(notificationOutbox)
        .set({ status: "SENT", sentAt: new Date(), attempts, error: null })
        .where(eq(notificationOutbox.id, row.id));
      sent++;
    } catch (e) {
      const err = e instanceof LinePushError ? e : new LinePushError(0, String(e), true);
      const permanent = !err.retryable || attempts >= MAX_ATTEMPTS;
      await db
        .update(notificationOutbox)
        .set({ status: permanent ? "FAILED" : "PENDING", attempts, error: err.message })
        .where(eq(notificationOutbox.id, row.id));
      if (permanent) failed++;
      else retry++;
    }
  }
  return { sent, failed, retry };
}

let running = false;

/** Start the polling worker. No-op (idle) if LINE isn't configured. Returns a stop fn. */
export function startOutboxWorker(intervalMs = 15_000): () => void {
  if (!lineConfigured()) {
    console.warn("[outbox] LINE_CHANNEL_ACCESS_TOKEN not set — worker idle (rows stay PENDING)");
    return () => {};
  }
  const tick = async () => {
    if (running) return; // prevent overlapping ticks
    running = true;
    try {
      const r = await processOutboxOnce();
      if (r.sent || r.failed || r.retry)
        console.info(`[outbox] sent=${r.sent} failed=${r.failed} retry=${r.retry}`);
    } catch (e) {
      console.error("[outbox] tick error:", e);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, intervalMs);
  void tick(); // run once on boot
  console.info(`[outbox] LINE worker started (every ${intervalMs / 1000}s)`);
  return () => clearInterval(handle);
}
