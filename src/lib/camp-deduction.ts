// TASK-443 (REQ-104 §2 item 5b / §3) — the DAY-END `camp_deduction` family notice, the PURE half: units → days and the
// ENGLISH-ONLY render (the owner's ruling: no Thai line regardless of `line_lang` — no `t()`, no `lang`; the bytes are the
// constants below, pinned identical under both languages). Half-day units ⇒ `3.5`; a whole number prints `4`, never `4.0`.
import { ddmmyyyy } from "./time";

export const CAMP_DEDUCTION_TITLE = "🏕️ CAMP CREDIT USED";

/** Units → days: FULL = 2 units = 1 day; AM/PM = 1 unit = 0.5 day. */
export const unitsToDays = (units: number): number => units / 2;

export interface CampDeductionPayload { studentName?: string | null; date?: string | null; remainingDays?: number | null; totalDays?: number | null }

export function renderCampDeduction(p: CampDeductionPayload): string {
  const num = (n: number | null | undefined) => (n == null ? "" : String(n));
  return [
    CAMP_DEDUCTION_TITLE,
    `Student : ${p.studentName ?? ""}`,
    `Date : ${p.date ? ddmmyyyy(p.date) : ""}`,
    `Remaining : ${num(p.remainingDays)}/${num(p.totalDays)} days`,
  ].join("\n");
}
