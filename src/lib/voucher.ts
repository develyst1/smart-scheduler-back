// Voucher validity rule (requirement.md). Hours → months, counted from the FIRST
// booking. Vouchers have no fixed schedule and cannot pick a teacher.

import { COURSE_LIVE, COURSE_LIVE_STATUSES } from "./course-plan";
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

/** 🔻 TASK-870 (REQ-5008) — the approved sentence «ชั่วโมงในวอยเชอร์หมดแล้ว», reused by the booking refusal AND the empty check-in (refusal / warning): no new words. */
export const VOUCHER_EMPTY_MESSAGE = "ชั่วโมงในวอยเชอร์หมดแล้ว";
/**
 * 🔻 TASK-870 (REQ-5008; ขวัญ ruled «B ka», 2026-11-08) — what a check-in on a voucher with NOTHING left does: "REFUSE" (the default) = 409 `VOUCHER_EXHAUSTED`, nothing written; "WARN" = the deduction happens and the response carries `voucherWarning`.
 * ONE constant — flipping it is one line + a deploy (no DB setting, no UI). The day-end auto-attend never refuses (a refused row would stay unsettled).
 */
export const VOUCHER_EMPTY_CHECKIN: "WARN" | "REFUSE" = "REFUSE";
/** 🔻 TASK-870 — what an attend does on THIS voucher: "ALLOW" while any hour is left, else the switch's value ("REFUSE" by default). `mode` is injectable only so BOTH values are tested. */
export const emptyVoucherCheckin = (v: Pick<VoucherLike, "totalHours" | "usedHours">, mode: "WARN" | "REFUSE" = VOUCHER_EMPTY_CHECKIN): "ALLOW" | "WARN" | "REFUSE" => (v.usedHours >= v.totalHours ? mode : "ALLOW");
/** 🔻 TASK-870 — the bookings that RESERVE a voucher hour: the ones a later deduction can still turn into ATTENDED (PENDING · CONFIRMED · EXTENDED — the ONE live set; SICK_LEAVE / PAUSED / CANCELLED / delivered rows reserve nothing). */
export const VOUCHER_RESERVING_STATUSES = COURSE_LIVE_STATUSES;
export const isVoucherReserving = (status: string): boolean => COURSE_LIVE.has(status);
/** 🔻 TASK-870 — hours still bookable = total − used − reserved (never below 0). `voucherRemaining` stays the used-based display figure. */
export const voucherAvailable = (v: Pick<VoucherLike, "totalHours" | "usedHours">, reserved: number): number =>
  Math.max(0, v.totalHours - v.usedHours - Math.max(0, reserved));

/** Can a session on `onDate` be booked against this voucher? (hours left AFTER what is already booked + not expired) — `reserved` defaults to 0 for the old callers. */
export function voucherUsable(v: VoucherLike, onDate: string, reserved = 0): { ok: boolean; reason?: string } {
  if (isVoucherEnded(v)) return { ok: false, reason: VOUCHER_ENDED_MESSAGE }; // TASK-439 — refused FIRST: an ended voucher draws nothing
  if (voucherAvailable(v, reserved) <= 0) return { ok: false, reason: VOUCHER_EMPTY_MESSAGE };
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
 * erase. "Live" is `COURSE_LIVE` itself, not a second list — the same definition a course end uses.
 * 🔻 TASK-870 Amendment 3 (O-148-1) — EVERY booking type that carries this voucher: a VOUCHER row AND an อื่นๆ row that deducts it (Amendment 2 made that possible), so the caller passes the voucher's own rows and there is no
 * type filter here any more (the old one said «a voucher never owns any other kind», which stopped being true).
 */
export const endableVoucherDraws = <T extends { status: string; date: string }>(rows: T[], today: string): T[] =>
  rows.filter((r) => COURSE_LIVE.has(r.status) && r.date >= today);
