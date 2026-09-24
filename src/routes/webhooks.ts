import { Hono } from "hono";
import { parseLineWebhook, verifyLineSignature } from "../lib/line-webhook";
import { formatBadSignature } from "../lib/line-log";
import { handleLineWebhookEvents } from "../services/line-webhook.service";

/** Public LINE Messaging API webhook (C.4) — no JWT; verified by X-Line-Signature. */
export const lineWebhook = new Hono().post("/line", async (c) => {
  const secret = process.env.LINE_CHANNEL_SECRET ?? "";
  const body = await c.req.text();
  const signature = c.req.header("x-line-signature");

  if (!verifyLineSignature(body, signature, secret)) {
    // 🔴 TASK-297 — `{ error: "invalid signature" }` put a STRING where every other refusal puts an
    // object, so a reader doing `body.error.code` or `.message` got `undefined` twice. Unseen because the
    // reader is LINE's servers rather than a person — **which is the DEF-5 lesson, not an excuse.**
    // 🚫 The signature CHECK is untouched, and so is the 401: only the shape of the answer changed.
    // 🔴 TASK-460 — this refusal used to answer and log NOTHING, so a wrong secret and a passing scanner looked
    // identical from here (and `routes/webhooks.ts:16` was the only place either could be seen).
    console.warn(
      formatBadSignature({
        hasSignature: !!signature,
        bodyLength: body.length,
        remote: c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? null,
      }),
    );
    return c.json({ error: { code: "INVALID_SIGNATURE", message: "invalid signature" } }, 401);
  }

  const parsed = parseLineWebhook(body);
  // 🔴 TASK-460 (DEF-1) — **ACK FIRST, PROCESS AFTER.** This `await` used to sit here, so every DB round trip, the
  // rich-menu calls and the reply all happened inside LINE's timeout: 14 x `request_timeout` on 2026-09-24, on the
  // REAL customer OA, at exactly the times we were chasing as "the message never arrived". It had arrived; LINE gave
  // up waiting for us. A reply token belongs to the EVENT, not to this response, so replying after the 200 is fine
  // (and is LINE's own guidance).
  //
  // 🚫 Nothing may be lost silently: the detached promise's rejection is caught and logged here as the LAST net —
  // `handleLineWebhookEvents` already catches per event and still sends TASK-449's apology where a token exists, so
  // reaching this line means something outside that loop threw.
  void handleLineWebhookEvents(parsed.events ?? []).catch((e) => {
    console.error("[line-webhook] detached handler rejected:", e);
  });
  return c.json({ ok: true });
});
