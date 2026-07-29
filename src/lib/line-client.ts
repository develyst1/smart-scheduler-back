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
  throw new LinePushError(res.status, `LINE push failed ${res.status}: ${body.slice(0, 300)}`, retryable);
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
