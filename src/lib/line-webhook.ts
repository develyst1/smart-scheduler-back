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

/** Normalize user role choice: "1" / "ลูกค้า" / "customer" → customer */
export function parseRoleChoice(text: string): "customer" | "teacher" | "admin" | null {
  const t = text.trim().toLowerCase();
  if (["1", "ลูกค้า", "customer", "นักเรียน", "ผู้ปกครอง"].includes(t)) return "customer";
  if (["2", "ครู", "teacher"].includes(t)) return "teacher";
  if (["3", "แอดมิน", "admin"].includes(t)) return "admin";
  return null;
}

export function normalizePhone(input: string): string {
  return input.replace(/\D/g, "");
}
