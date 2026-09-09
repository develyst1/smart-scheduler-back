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
  // 🔴 TASK-310 (REQ-079 §17c screen 2) — `next` is the CUSTOMER'S word, and the only one a parent is ever
  // shown: *"กรุณาพิมพ์ “Next” เพื่อเข้าใช้งานค่ะ"*. ⚠️ The older words stay ACCEPTED — a parent who
  // learned `ผู้ปกครอง` from the retired picker must not be met by a refusal — they are simply never
  // advertised again. 🚫 `CEO` is absent BY RULING (`§17e-1`): the word lives in the customer's copy and in
  // the REQ and becomes no code path. **Adding it would be building a role the owner struck out.**
  if (["next", "ลูกค้า", "customer", "นักเรียน", "ผู้ปกครอง", "พ่อ", "แม่", "parent"].includes(t)) return "customer";
  if (["ครู", "teacher"].includes(t)) return "teacher";
  if (["แอดมิน", "admin"].includes(t)) return "admin";
  return null;
}

export function normalizePhone(input: string): string {
  return input.replace(/\D/g, "");
}

/**
 * 🔴 TASK-278 §6 (REQ-079 §3c) — `0825031502` → `082-503-1502`, for DISPLAY ONLY.
 *
 * Their screen 4 shows `เบอร์โทรศัพท์ / Phone: 082-503-1502`, so rendering their copy faithfully IS the
 * formatting — and §3c asked for it on 09-06 as *"cosmetic, cheap, do them"* and it was never built.
 *
 * 🚫 **It is deliberately NOT the inverse of `normalizePhone`, and it must never be used as one.** Every
 * stored, compared and looked-up value stays the digits: a formatted number reaching a lookup is how a
 * family stops matching their own record. Its only caller is the message layer, and a test asserts that.
 *
 * ⚠️ **An unrecognised number passes through UNCHANGED** — not mangled into groups. We accept what people
 * type (`normalizePhone` strips anything non-digit), so a 9-digit landline or a `66…` international form
 * reaches here; inventing a shape for a number we do not recognise would print something the parent has
 * never seen and cannot check against their phone.
 */
export function formatPhoneForDisplay(phone: string): string {
  return /^0\d{9}$/.test(phone) ? `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}` : phone;
}
