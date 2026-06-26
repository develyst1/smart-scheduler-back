// Voucher validity rule (requirement.md). Hours → months, counted from the FIRST
// booking. Vouchers have no fixed schedule and cannot pick a teacher.

import { fmtDate } from "./time";

export const VOUCHER_VALIDITY_MONTHS: Record<number, number> = { 5: 3, 10: 6, 15: 9 };

/** Expiry = first-booking date + N months (5h→3mo, 10h→6mo, 15h→9mo). */
export function voucherExpiry(totalHours: number, firstBookingDate: string): string {
  const months = VOUCHER_VALIDITY_MONTHS[totalHours] ?? 0;
  const d = new Date(`${firstBookingDate}T00:00:00`);
  d.setMonth(d.getMonth() + months);
  return fmtDate(d);
}
