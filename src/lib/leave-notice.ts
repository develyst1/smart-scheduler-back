// Advance-notice-for-leave rule (UC-029). Leave must be requested at least N hours before class start.
//
// SPEC-048 / TASK-146 (REQ-047): N used to be a hard-coded constant per teacher type (60/60/120 minutes).
// It is now an editable **setting** — `leave_cutoff_hours_fulltime` (FULL_TIME + PART_TIME) and
// `leave_cutoff_hours_freelance` — so staff change it on the Settings screen, no deploy, no SQL. This module
// keeps the pure comparator + the copy and stops owning the numbers; the service resolves the setting at
// action time (SPEC-029's rule) and passes the value in.

import { bangkokNow, timeToMinutes, type BangkokNow } from "./bangkok-time";
import type { Lang } from "./line-i18n";

export type LeaveNoticeTeacherType = "FULL_TIME" | "PART_TIME" | "FREELANCE";

/** Which setting governs this teacher's leave cut-off. PART_TIME shares the full-time rule (REQ-047). */
export const leaveCutoffKey = (type: LeaveNoticeTeacherType) =>
  type === "FREELANCE" ? ("leave_cutoff_hours_freelance" as const) : ("leave_cutoff_hours_fulltime" as const);

const dayNumber = (isoDate: string): number => {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** Minutes from `now` until the class starts (negative if already started/past). */
export function minutesUntilClass(
  bookingDate: string,
  startTime: string,
  now: BangkokNow = bangkokNow(),
): number {
  const dayDiff = dayNumber(bookingDate) - dayNumber(now.date);
  return dayDiff * 1440 + (timeToMinutes(startTime) - now.minutes);
}

/** True when leave is requested with enough advance notice. `cutoffHours` is the resolved setting.
 *  `>=` on purpose (AC-3): exactly N hours before the session is still allowed. */
export function hasEnoughLeaveNotice(
  bookingDate: string,
  startTime: string,
  cutoffHours: number,
  now: BangkokNow = bangkokNow(),
): boolean {
  return minutesUntilClass(bookingDate, startTime, now) >= cutoffHours * 60;
}

/**
 * Refusal copy (AC-7) — 🔻 TASK-717 (R147): **KHWAN's words**, owner-APPROVED (`COPY-REVIEW-2026-09-29.md:592` item 4), the number from the SETTING (`cutoffHours`, per coach type) and never a fixed 1.
 * Two lines (a line break between the sentence and the emergency line), in the reader's language: TH for the calendar's `LEAVE_NOTICE_TOO_LATE` refusal (a server refusal is Thai), the reader's own for the
 * parent's «ลา» in LINE. Her sentence has no "this one starts at {time}", so `_startTime` is IGNORED — kept in the signature only so both doors (and their pins) are untouched.
 */
export function leaveNoticeMessage(cutoffHours: number, _startTime: string, lang: Lang = "TH"): string {
  return lang === "EN"
    ? `Sorry, absences must be requested at least ${cutoffHours} hour(s) before the class starts.\nFor emergencies, please contact Admin.`
    : `ขออภัยค่ะ การลาต้องแจ้งล่วงหน้าอย่างน้อย ${cutoffHours} ชม. ก่อนเริ่มคลาส\nกรณีฉุกเฉิน กรุณาติดต่อแอดมินค่ะ`;
}
