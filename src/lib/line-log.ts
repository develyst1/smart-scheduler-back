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
  // 🔴 TASK-460 — the EVENT ID and the redelivery flag. We are about to stop using LINE's console as our evidence
  // (it showed `request_timeout`; after the ACK-first change every delivery is a 200), so the log has to carry what
  // the console used to tell us. `id=` also joins this line to its FINISH line below — **a lost step must read as a
  // line with no finish, not as nothing at all.**
  const parts = [`type=${ev.type ?? "?"}`, `id=${ev.webhookEventId ?? "(none)"}`, who];
  if (ev.deliveryContext?.isRedelivery) parts.push("REDELIVERY");
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

/**
 * 🔴 TASK-460 — the other half of `[line-in]`: one line when the event is DONE, carrying the same id, what
 * happened, and how long it took. The elapsed figure is the point — it is the number that would have shown us
 * DEF-1 months ago (LINE's timeout is a wall we could not see from inside).
 */
export function formatEventFinish(ev: LineWebhookEvent, outcome: string, elapsedMs: number): string {
  return `[line-in] FINISH id=${ev.webhookEventId ?? "(none)"} ${userMarker(ev.source?.userId)} outcome=${outcome} ms=${Math.round(elapsedMs)}`;
}

/**
 * The rejected-signature line. 🚫 NEVER the body (it is signed third-party content) and never the signature —
 * the LENGTH and whether a header arrived at all are what actually distinguish "a scanner hit the URL" from
 * "our secret is wrong", which is the question this line exists to answer.
 */
export function formatBadSignature(o: { hasSignature: boolean; bodyLength: number; remote?: string | null }): string {
  return `[line-in] 401 invalid signature — sig=${o.hasSignature ? "present" : "MISSING"} bodyLen=${o.bodyLength} from=${o.remote ?? "(unknown)"}`;
}
