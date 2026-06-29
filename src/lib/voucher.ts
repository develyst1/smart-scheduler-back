// Voucher validity rule (requirement.md). Hours → months, counted from the FIRST
// booking. Vouchers have no fixed schedule and cannot pick a teacher.

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
}

export const voucherRemaining = (v: VoucherLike): number =>
  Math.max(0, v.totalHours - v.usedHours);

/** Can a session on `onDate` be booked against this voucher? (hours left + not expired) */
export function voucherUsable(v: VoucherLike, onDate: string): { ok: boolean; reason?: string } {
  if (voucherRemaining(v) <= 0) return { ok: false, reason: "ชั่วโมงในวอยเชอร์หมดแล้ว" };
  if (onDate > v.expiryDate) return { ok: false, reason: "วอยเชอร์หมดอายุแล้ว" };
  return { ok: true };
}
