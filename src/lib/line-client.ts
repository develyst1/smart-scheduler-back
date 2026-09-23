// Thin LINE Messaging API client (Official Account push). Server-side only — the
// channel access token never leaves the backend. LINE Notify is dead (2025-03-31);
// this uses the Messaging API push endpoint.

const LINE_API = "https://api.line.me/v2/bot";

/** A tappable action on a quick-reply button or rich-menu area (REQ-015 / TASK-038). */
export type LineAction =
  | { type: "postback"; label?: string; data: string; displayText?: string }
  | { type: "message"; label: string; text: string }
  | { type: "uri"; label: string; uri: string };

export interface LineQuickReply {
  items: Array<{ type: "action"; imageUrl?: string; action: LineAction }>;
}

export interface LineTextMessage {
  type: "text";
  text: string;
  quickReply?: LineQuickReply;
}

/** Flex bubble/carousel — `contents` is the LINE flex container JSON (kept loose on purpose). */
export interface LineFlexMessage {
  type: "flex";
  altText: string;
  contents: unknown;
  quickReply?: LineQuickReply;
}

export type LineMessage = LineTextMessage | LineFlexMessage;

export const lineConfigured = () => !!process.env.LINE_CHANNEL_ACCESS_TOKEN;

/**
 * 🔴 TASK-450 (REQ-105 §7c) — **a count is not a diagnosis.** The outbox logged `sent=0 failed=N` all afternoon on
 * `sid` and nobody could tell a monthly-quota wall from an invalid token without opening the database. LINE answers
 * a failed push with JSON — `{ "message": "…", "details": [{ "message": "…", "property": "…" }] }` — so the reason
 * is already in our hands at the moment of failure; it was being stored as a 300-character raw slice and summarised
 * as a number. This turns the body into the one sentence a human needs, and falls back to the raw text (never to
 * nothing) when the body is not the JSON we expect.
 */
export function describeLineError(status: number, body: string): string {
  const raw = (body ?? "").trim();
  let detail = "";
  try {
    const j = JSON.parse(raw) as { message?: string; details?: Array<{ message?: string; property?: string }> };
    const parts = [j.message, ...(j.details ?? []).map((d) => [d.property, d.message].filter(Boolean).join(" "))].filter(Boolean) as string[];
    detail = [...new Set(parts)].join(" — ");
  } catch {
    detail = "";
  }
  const text = detail || raw.slice(0, 300);
  return `LINE push failed ${status}${text ? `: ${text}` : ""}`;
}

export class LinePushError extends Error {
  constructor(
    public status: number,
    message: string,
    /** transient (429 / 5xx / network) → worth retrying; 4xx → permanent. */
    public retryable: boolean,
  ) {
    super(message);
  }
}

/** Reply to a webhook event (one replyToken, one chance). */
export async function replyMessage(replyToken: string, messages: LineMessage[]): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new LinePushError(0, "LINE_CHANNEL_ACCESS_TOKEN not set", true);

  let res: Response;
  try {
    res = await fetch(`${LINE_API}/message/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ replyToken, messages }),
    });
  } catch (e) {
    throw new LinePushError(0, `LINE network error: ${String(e)}`, true);
  }

  if (res.ok) return;
  const body = await res.text().catch(() => "");
  const retryable = res.status === 429 || res.status >= 500;
  throw new LinePushError(res.status, `LINE reply failed ${res.status}: ${body.slice(0, 300)}`, retryable);
}

/** Push up to 5 messages to one recipient. Throws LinePushError on non-2xx. */
export async function pushMessage(to: string, messages: LineMessage[]): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new LinePushError(0, "LINE_CHANNEL_ACCESS_TOKEN not set", true);

  let res: Response;
  try {
    res = await fetch(`${LINE_API}/message/push`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages }),
    });
  } catch (e) {
    // network failure → retryable
    throw new LinePushError(0, `LINE network error: ${String(e)}`, true);
  }

  if (res.ok) return;
  const body = await res.text().catch(() => "");
  // 429 (rate limit) and 5xx are transient; other 4xx (invalid token/userId) are permanent.
  const retryable = res.status === 429 || res.status >= 500;
  throw new LinePushError(res.status, describeLineError(res.status, body), retryable);
}

/** GET /profile/{userId}.language → seed the bot language on first link (best-effort; null on any failure). */
export async function getProfileLang(userId: string): Promise<"TH" | "EN" | null> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`${LINE_API}/profile/${userId}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const p = (await res.json()) as { language?: string };
    return p.language?.toLowerCase().startsWith("en") ? "EN" : "TH";
  } catch {
    return null;
  }
}

/** GET /bot/info — used to verify the token without needing a recipient. */
export async function getBotInfo(): Promise<unknown> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new LinePushError(0, "LINE_CHANNEL_ACCESS_TOKEN not set", true);
  const res = await fetch(`${LINE_API}/info`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new LinePushError(res.status, `bot/info ${res.status}`, res.status >= 500);
  return res.json();
}
