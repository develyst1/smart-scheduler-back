import { Hono } from "hono";
import { parseLineWebhook, verifyLineSignature } from "../lib/line-webhook";
import { handleLineWebhookEvents } from "../services/line-webhook.service";

/** Public LINE Messaging API webhook (C.4) — no JWT; verified by X-Line-Signature. */
export const lineWebhook = new Hono().post("/line", async (c) => {
  const secret = process.env.LINE_CHANNEL_SECRET ?? "";
  const body = await c.req.text();
  const signature = c.req.header("x-line-signature");

  if (!verifyLineSignature(body, signature, secret)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  const parsed = parseLineWebhook(body);
  // LINE expects 200 quickly — process synchronously (replies use replyToken).
  await handleLineWebhookEvents(parsed.events ?? []);
  return c.json({ ok: true });
});
