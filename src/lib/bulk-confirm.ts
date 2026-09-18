// Bulk-confirm pre-check (REQ-008 / TASK-036) — pure, unit-testable. Decides an id's fate from its current
// booking BEFORE touching the DB: PENDING or EXTENDED → proceed to the real single-confirm; already confirmed/
// attended → idempotent no-op; anything else (or missing) → skipped, so a bulk call can never un-cancel a booking.
//
// 🔻 TASK-389 (REQ-094): a make-up is born EXTENDED (purple) and the single confirm accepts it (no status guard),
// but this pre-check proceeded for PENDING only — so a bulk confirm skipped every make-up, it stayed EXTENDED, and
// the end-of-day auto-mark (CONFIRMED-only, correctly) never attended it. Not a design; a filter. EXTENDED now
// proceeds like PENDING; the job's select is untouched.
import type { BulkConfirmOutcome } from "../types/contract";

export type BulkPreCheck =
  | { proceed: true }
  | { proceed: false; outcome: Exclude<BulkConfirmOutcome, "confirmed">; reason?: string };

export function preCheckBulkConfirm(booking: { status: string } | null | undefined): BulkPreCheck {
  if (!booking) return { proceed: false, outcome: "skipped", reason: "ไม่พบคาบเรียน" };
  if (booking.status === "PENDING" || booking.status === "EXTENDED") return { proceed: true };
  if (booking.status === "CONFIRMED" || booking.status === "ATTENDED")
    return { proceed: false, outcome: "already_confirmed" };
  return { proceed: false, outcome: "skipped", reason: "ไม่ใช่คาบที่รอยืนยัน" };
}
