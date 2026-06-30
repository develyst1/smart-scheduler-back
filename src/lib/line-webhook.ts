// LINE webhook helpers — signature verify + minimal event types (C.4).

import { createHmac, timingSafeEqual } from "node:crypto";

export interface LineTextMessage {
  type: "text";
  id: string;
  text: string;
}

export interface LineWebhookEvent {
  type: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: LineTextMessage;
}

export interface LineWebhookBody {
  destination?: string;
  events: LineWebhookEvent[];
}

export function verifyLineSignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const hash = createHmac("sha256", secret).update(body).digest("base64");
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
