import { Hono } from "hono";
import { parseLineWebhook, verifyLineSignature } from "../lib/line-webhook";
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
    return c.json({ error: { code: "INVALID_SIGNATURE", message: "invalid signature" } }, 401);
  }

  const parsed = parseLineWebhook(body);
  // LINE expects 200 quickly — process synchronously (replies use replyToken).
  await handleLineWebhookEvents(parsed.events ?? []);
  return c.json({ ok: true });
});
