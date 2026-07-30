// Inbound LINE webhook observability (REQ-015 prod defect / TASK-045). Pure formatters so they're unit-testable
// and so the privacy rule is enforced in ONE place: we never log a full LINE userId (a stable hash prefix is
// used for correlation instead) and never log a channel token.
//
// Why this exists: a *successful* postback used to log nothing, and `handlePostback` returned silently when a
// field was missing — so "LINE never sent the event" and "we received it and dropped it" looked identical in
// the logs. These lines make those two cases distinguishable.
import { createHash } from "node:crypto";
import type { LineWebhookEvent } from "./line-webhook";

/** Short, stable, non-reversible marker for a LINE userId — enough to correlate events from one user. */
export function userMarker(lineUserId: string | null | undefined): string {
  if (!lineUserId) return "u:none";
  return `u:${createHash("sha256").update(lineUserId).digest("hex").slice(0, 8)}`;
}

/** One line per inbound event, logged BEFORE dispatch. Postbacks include their raw `data` (the action key —
 *  not a credential), which is the whole point: it proves the tap reached us. */
export function formatInboundEvent(ev: LineWebhookEvent): string {
  const who = userMarker(ev.source?.userId);
  const parts = [`type=${ev.type ?? "?"}`, who];
  if (ev.type === "postback") parts.push(`data=${ev.postback?.data ?? "(none)"}`);
  else if (ev.type === "message") parts.push(`msgType=${ev.message?.type ?? "?"}`);
  return `[line-in] ${parts.join(" ")}`;
}

/** Logged early-exit: says exactly WHICH field was missing instead of returning silently. */
export function formatDroppedPostback(ev: LineWebhookEvent): string {
  const missing: string[] = [];
  if (!ev.replyToken) missing.push("replyToken");
  if (!ev.source?.userId) missing.push("userId");
  if (!ev.postback?.data) missing.push("data");
  return `[line-in] DROPPED postback — missing: ${missing.join(",") || "(nothing?)"} ${userMarker(ev.source?.userId)}`;
}

/** An action we received but have no branch for — otherwise indistinguishable from "nothing arrived". */
export function formatUnknownAction(action: string, lineUserId: string | null | undefined): string {
  return `[line-in] postback with UNHANDLED action=${action || "(empty)"} ${userMarker(lineUserId)}`;
}
