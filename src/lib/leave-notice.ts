// Advance-notice-for-leave rule (UC-029). Leave must be requested at least N
// minutes before class start, where N depends on the teacher's type. Pure helpers
// — no DB. The server enforces this; an admin may override for special cases.

import { bangkokNow, timeToMinutes, type BangkokNow } from "./bangkok-time";

export type LeaveNoticeTeacherType = "FULL_TIME" | "PART_TIME" | "FREELANCE";

/** Minutes of advance notice required to take leave, by teacher type. */
export const LEAVE_NOTICE_MINUTES: Record<LeaveNoticeTeacherType, number> = {
  FULL_TIME: 60,
  PART_TIME: 60,
  FREELANCE: 120,
};

export const leaveNoticeMinutes = (type: LeaveNoticeTeacherType) =>
  LEAVE_NOTICE_MINUTES[type] ?? 60;

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

/** True when leave is requested with enough advance notice for this teacher type. */
export function hasEnoughLeaveNotice(
  bookingDate: string,
  startTime: string,
  type: LeaveNoticeTeacherType,
  now: BangkokNow = bangkokNow(),
): boolean {
  return minutesUntilClass(bookingDate, startTime, now) >= leaveNoticeMinutes(type);
}

/** Human-readable rejection message (Thai UI copy). */
export function leaveNoticeMessage(type: LeaveNoticeTeacherType): string {
  const hours = leaveNoticeMinutes(type) / 60;
  return `ต้องแจ้งลาล่วงหน้าอย่างน้อย ${hours} ชั่วโมงก่อนเริ่มคลาส`;
}
