// Teacher-change advance-notice rule (SPEC-028 §5 #3 / REQ-030 Q3). A per-session teacher swap must be made at
// least N DAYS before the class so the new teacher gets warning — a silent last-minute reassignment means
// someone doesn't turn up. Pure, mirroring `lib/leave-notice.ts` but in whole DAYS.
//
// 🔗 The threshold is PASSED IN (default 3). REQ-031 makes it editable via a settings screen by feeding the
// override into `days` — so this file stays pure and does NOT read `app_settings`.

import { bangkokNow, type BangkokNow } from "./bangkok-time";
import { minutesUntilClass } from "./leave-notice";

export const DEFAULT_TEACHER_CHANGE_NOTICE_DAYS = 3;

/** Whole days from `now` until the class (floored — 2.9 days is NOT 3 days' notice). */
export function daysUntilClass(
  bookingDate: string,
  startTime: string,
  now: BangkokNow = bangkokNow(),
): number {
  return Math.floor(minutesUntilClass(bookingDate, startTime, now) / 1440);
}

/** Enough advance notice for a teacher change? `days` defaults to 3 (REQ-031 passes an override in). */
export function hasEnoughTeacherChangeNotice(
  bookingDate: string,
  startTime: string,
  now: BangkokNow = bangkokNow(),
  days: number = DEFAULT_TEACHER_CHANGE_NOTICE_DAYS,
): boolean {
  return daysUntilClass(bookingDate, startTime, now) >= days;
}

/** Thai rejection message. */
export function teacherChangeNoticeMessage(days: number = DEFAULT_TEACHER_CHANGE_NOTICE_DAYS): string {
  return `ต้องเปลี่ยนครูล่วงหน้าอย่างน้อย ${days} วันก่อนเริ่มคลาส`;
}
