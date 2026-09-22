// Voucher validity rule (requirement.md). Hours → months, counted from the FIRST
// booking. Vouchers have no fixed schedule and cannot pick a teacher.

import { COURSE_LIVE } from "./course-plan";
import { fmtDate } from "./time";

export const VOUCHER_HOURS = [5, 10, 15] as const;
export type VoucherHours = (typeof VOUCHER_HOURS)[number];
export const VOUCHER_VALIDITY_MONTHS: Record<number, number> = { 5: 3, 10: 6, 15: 9 };

export const isVoucherHours = (n: number): n is VoucherHours =>
  (VOUCHER_HOURS as readonly number[]).includes(n);

/** Expiry = first-booking date + N months (5h→3mo, 10h→6mo, 15h→9mo). */
export function voucherExpiry(totalHours: number, firstBookingDate: string): string {
  const months = VOUCHER_VALIDITY_MONTHS[totalHours] ?? 0;
  const d = new Date(`${firstBookingDate}T00:00:00`);
  d.setMonth(d.getMonth() + months);
  return fmtDate(d);
}

export interface VoucherLike {
  totalHours: number;
  usedHours: number;
  expiryDate: string;
  /** TASK-439 (REQ-103): set when the whole voucher was cancelled — no new draw, the balance frozen, the past untouched. */
  endedAt?: Date | string | null;
}

/** TASK-439 — the ONE "is this voucher ended" predicate; the draw gate, the status and the creator's 409 all read it. */
export const isVoucherEnded = (v: Pick<VoucherLike, "endedAt">): boolean => v.endedAt != null;
export const VOUCHER_ENDED_MESSAGE = "วอยเชอร์นี้ถูกยกเลิกแล้ว";

export const voucherRemaining = (v: VoucherLike): number =>
  Math.max(0, v.totalHours - v.usedHours);

/** Can a session on `onDate` be booked against this voucher? (hours left + not expired) */
export function voucherUsable(v: VoucherLike, onDate: string): { ok: boolean; reason?: string } {
  if (isVoucherEnded(v)) return { ok: false, reason: VOUCHER_ENDED_MESSAGE }; // TASK-439 — refused FIRST: an ended voucher draws nothing
  if (voucherRemaining(v) <= 0) return { ok: false, reason: "ชั่วโมงในวอยเชอร์หมดแล้ว" };
  if (onDate > v.expiryDate) return { ok: false, reason: "วอยเชอร์หมดอายุแล้ว" };
  return { ok: true };
}

/**
 * TASK-439 (REQ-103) — the voucher's ONE status derivation, the course's precedence: an END outranks everything (a voucher
 * both ended and expired reads ENDED — the end is the human's decision, the expiry the calendar's), then EXPIRED, then
 * EXHAUSTED (no hours left), else ACTIVE. `GET /vouchers` reads it; nothing else derives a status.
 */
export const VOUCHER_STATUSES = ["ACTIVE", "EXHAUSTED", "EXPIRED", "ENDED"] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];
export function voucherStatus(v: VoucherLike, today: string): VoucherStatus {
  if (isVoucherEnded(v)) return "ENDED";
  if (today > v.expiryDate) return "EXPIRED";
  if (voucherRemaining(v) <= 0) return "EXHAUSTED";
  return "ACTIVE";
}

/**
 * TASK-439 — which of a voucher's draws a whole-voucher cancel removes: **the LIVE ones dated today or later.**
 *
 * The course twin (`endableSessions`) has no date rule — a course end forfeits every live row — but the owner's REQ-103 rule
 * is "future draws": a past-dated draw still PENDING/CONFIRMED is the day-end's to settle (attended or not), not the end's to
 * erase. "Live" is `COURSE_LIVE` itself, not a second list — the same definition a course end uses. Only VOUCHER rows: a
 * voucher never owns any other kind, so the type filter is a guard, not a rule.
 */
export const endableVoucherDraws = <T extends { status: string; bookingType?: string; date: string }>(rows: T[], today: string): T[] =>
  rows.filter((r) => r.bookingType === "VOUCHER" && COURSE_LIVE.has(r.status) && r.date >= today);
