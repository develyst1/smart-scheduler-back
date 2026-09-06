// LINE webhook helpers — signature verify + minimal event types (C.4).

import { createHmac, timingSafeEqual } from "node:crypto";

export interface LineTextMessage {
  type: "text";
  id: string;
  text: string;
}

export interface LinePostback {
  data: string;
}

export interface LineWebhookEvent {
  type: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: LineTextMessage;
  postback?: LinePostback;
}

export interface LineWebhookBody {
  destination?: string;
  events: LineWebhookEvent[];
}

export function verifyLineSignature(body: string, signature: string | undefined, secret: string): boolean {
  const trimmed = secret.trim();
  if (!signature || !trimmed) return false;
  const hash = createHmac("sha256", trimmed).update(body).digest("base64");
  try {
    const a = Buffer.from(hash);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function parseLineWebhook(body: string): LineWebhookBody {
  return JSON.parse(body) as LineWebhookBody;
}

export function eventUserId(ev: LineWebhookEvent): string | null {
  return ev.source?.userId ?? null;
}

export function eventText(ev: LineWebhookEvent): string | null {
  if (ev.type !== "message" || ev.message?.type !== "text") return null;
  return ev.message.text.trim();
}

export function eventPostbackData(ev: LineWebhookEvent): string | null {
  if (ev.type !== "postback") return null;
  return ev.postback?.data ?? null;
}

/**
 * Parse a rich-menu / quick-reply postback payload (`action=checkin&bookingId=…`) into a stable action key
 * plus params. Pure — the webhook routes the returned `action` to the same handler a keyword uses.
 */
export function parsePostback(data: string): { action: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(data)) params[k] = v;
  return { action: params.action ?? "", params };
}

/**
 * Normalize a typed role choice: `ผู้ปกครอง` / `customer` → customer.
 *
 * 🔴 TASK-251 (REQ-079 §16) — **the bare numbers are gone.** `1 / 2 / 3` collided with numbered replies the
 * customer's own OA already owns, on a live account. The sweep found this is the ONE parser in the product that
 * accepted a bare number — `เช็คอิน <n>` / `ลา <n>` need a keyword first, so a lone `2` never reaches them — so
 * closing it here removes the collision from the product rather than discouraging it.
 *
 * ✅ **The words stay, and `พ่อ` / `แม่` join them.** The picker is the front door, but LINE on PC cannot tap a
 * quick reply, so a typed answer is the path that must not close.
 * ⚠️ A parent who learned `1/2/3` now takes the AC-18 strike path and, on a second miss, reaches a person. That
 * is correct and deliberate: a special case for a retired input is a rule nobody would remember to delete.
 */
export function parseRoleChoice(text: string): "customer" | "teacher" | "admin" | null {
  const t = text.trim().toLowerCase();
  if (["ลูกค้า", "customer", "นักเรียน", "ผู้ปกครอง", "พ่อ", "แม่", "parent"].includes(t)) return "customer";
  if (["ครู", "teacher"].includes(t)) return "teacher";
  if (["แอดมิน", "admin"].includes(t)) return "admin";
  return null;
}

export function normalizePhone(input: string): string {
  return input.replace(/\D/g, "");
}
