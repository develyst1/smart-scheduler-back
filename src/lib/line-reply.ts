// LINE reply builders (REQ-015 / TASK-038-039) — tappable quick-reply / flex messages, rendered in the user's
// language. Pure (no DB / no LINE API): callers pass the already-translated `prompt`/`title`/`body`; the builders
// only add the language-correct "back to menu" quick reply, so the whole reply layer is bilingual via `t()`.
import type { LineMessage, LineQuickReply } from "./line-client";
import { t, type Lang } from "./line-i18n";

/** The "back to menu" quick-reply button (in the user's language) appended so no reply is a dead end. */
export function backToMenuItem(lang: Lang): LineQuickReply["items"][number] {
  const label = t("btn_back", lang);
  return { type: "action", action: { type: "postback", label, data: "action=menu", displayText: label } };
}

/** A plain text reply that always keeps a "back to menu" tap (plus any extra quick-reply items). */
export function textReply(body: string, lang: Lang, extra: LineQuickReply["items"] = []): LineMessage {
  return { type: "text", text: body, quickReply: { items: [...extra, backToMenuItem(lang)] } };
}

/** LINE limits: quick-reply ≤ 13 items, label ≤ 20 chars. */
const clampLabel = (s: string) => (s.length > 20 ? `${s.slice(0, 19)}…` : s);

/**
 * Quick-reply picker: one button per booking carrying its id in the postback, so a tap replaces "type 1/2".
 * `action` is the postback action the tap fires (`checkin` | `leave`). `prompt` is already translated.
 */
export function bookingPicker(
  prompt: string,
  action: "checkin" | "leave" | "qr",
  bookings: Array<{ id: string; label: string }>,
  lang: Lang,
): LineMessage {
  const items: LineQuickReply["items"] = bookings.slice(0, 12).map((b) => ({
    type: "action",
    action: {
      type: "postback",
      label: clampLabel(b.label),
      data: `action=${action}&bookingId=${b.id}`,
      displayText: b.label,
    },
  }));
  items.push(backToMenuItem(lang));
  return { type: "text", text: prompt, quickReply: { items } };
}

/**
 * 🔴 TASK-251 (REQ-079 §16) — the role step, as buttons.
 *
 * The third picker in this file, and the same shape as its two siblings on purpose: **a tap replaces "type
 * 1/2"**, which is what `bookingPicker`'s own comment says it exists for. The role step was the one that never
 * got one.
 *
 * ✅ **Postbacks, not text quick-replies:** a postback is OUR payload on OUR namespace, so it cannot be confused
 * with whatever the customer's own OA numbers on its account. The collision stops being discouraged and becomes
 * **impossible** — the difference between fixing the copy and fixing the cause.
 */
export function rolePicker(
  prompt: string,
  labels: { customer: string; teacher: string; admin: string },
  lang: Lang,
): LineMessage {
  const items: LineQuickReply["items"] = (
    [
      ["customer", labels.customer],
      ["teacher", labels.teacher],
      ["admin", labels.admin],
    ] as const
  ).map(([role, label]) => ({
    type: "action",
    action: {
      type: "postback",
      label: clampLabel(label),
      data: `action=role&role=${role}`,
      displayText: label,
    },
  }));
  items.push(backToMenuItem(lang));
  return { type: "text", text: prompt, quickReply: { items } };
}

/**
 * TASK-135 (AC-3): "which child?" step — one tappable button per child, carrying the studentId so the next
 * step filters to that child's sessions. Same shape as `bookingPicker`, different payload key.
 */
export function childPicker(
  prompt: string,
  children: Array<{ studentId: string; name: string }>,
  lang: Lang,
): LineMessage {
  const items: LineQuickReply["items"] = children.slice(0, 12).map((c) => ({
    type: "action",
    action: {
      type: "postback",
      label: clampLabel(c.name),
      data: `action=leave&studentId=${c.studentId}`,
      displayText: c.name,
    },
  }));
  items.push(backToMenuItem(lang));
  return { type: "text", text: prompt, quickReply: { items } };
}

/** Render a student list as a flex bubble, with a back-to-menu quick reply. `title` is already translated. */
export function childrenFlex(title: string, names: string[], lang: Lang): LineMessage {
  const rows = names.map((name, i) => ({
    type: "text",
    text: `${i + 1}. ${name}`,
    size: "sm",
    wrap: true,
    margin: "sm",
  }));
  const contents = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [{ type: "text", text: title, weight: "bold", size: "lg" }, ...rows],
    },
  };
  return { type: "flex", altText: title, contents, quickReply: { items: [backToMenuItem(lang)] } };
}
