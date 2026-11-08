// 🔻 TASK-888 (REQ-120 R1.5) - the PURE half of the pay-slip confirm reminder: when the scheduled job may act, the send-once key, and the words.
// No database, no clock, no LINE. The coach is told to confirm their slip BEFORE 12:00 on the last day of the month (not confirmed => paid as shown).
// 🚫 The text NEVER carries a pay figure: it names the deadline date and nothing else. (The WHO - the unconfirmed list - belongs to backoffice-back.)

export type RemindReason = "0900" | "1100" | "now";
export const REMIND_REASONS: readonly RemindReason[] = ["0900", "1100", "now"];

/** The last day of the month that `YYYY-MM-DD` falls in (the confirm day of that month's pay period). */
export function lastDayOfMonth(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`not a real date: ${date}`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` is the LAST day of its month. */
export const isLastDayOfMonth = (date: string): boolean => lastDayOfMonth(date) === date;

/**
 * The send-once key. A scheduled reminder is once per (period, person, reason): a re-tick of the 09:00 job cannot send twice. "Remind now" is the CEO's deliberate
 * action, so it repeats, but not on a double-click: one per person per 5-minute bucket of the Bangkok clock. `periodId` falls back to the month when the caller sent none.
 */
export function reminderKey(period: string, teacherId: string, reason: RemindReason, bangkokDate: string, bangkokTime: string): string {
  if (reason !== "now") return `payconfirm:${period}:${teacherId}:${reason}`;
  const [h, m] = bangkokTime.split(":").map(Number);
  const bucket = `${String(h).padStart(2, "0")}${String(Math.floor((m ?? 0) / 5) * 5).padStart(2, "0")}`;
  return `payconfirm:${period}:${teacherId}:now:${bangkokDate}T${bucket}`;
}

/** What goes in the outbox row's payload (rendered later by `formatOutboxMessage`, in the recipient's language). No money. */
export function reminderPayload(reason: RemindReason, confirmDate: string) {
  return { kind: "pay_confirm_reminder" as const, reason, confirmDate };
}

const ddmmyyyy = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

type Payload = { [k: string]: unknown; reason?: unknown; confirmDate?: unknown };

/** The LINE text. TH by default, EN for an English chat. A pay figure is never in it. */
export function renderPayConfirmReminder(payload: Payload, lang: "TH" | "EN" = "TH"): string {
  const reason = payload.reason as RemindReason | undefined;
  const date = typeof payload.confirmDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.confirmDate) ? ddmmyyyy(payload.confirmDate) : "";
  if (lang === "EN") {
    const left = reason === "0900" ? " (3 hours left)" : reason === "1100" ? " (1 hour left)" : "";
    return [`⏰ Please confirm your pay slip before 12:00${date ? ` on ${date}` : ""}${left}.`, "If it is not confirmed, you are paid the amount shown, with no edits."].join("\n");
  }
  const left = reason === "0900" ? " (เหลืออีก 3 ชั่วโมง)" : reason === "1100" ? " (เหลืออีก 1 ชั่วโมง)" : "";
  return [`⏰ ยืนยันสลิปเงินเดือนก่อน 12:00 ของ ${date || "วันนี้"}${left}`, "หากไม่ยืนยัน ระบบจะจ่ายตามยอดที่แสดงในสลิป และแก้ไขไม่ได้"].join("\n");
}
