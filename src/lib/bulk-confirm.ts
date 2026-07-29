// Bulk-confirm pre-check (REQ-008 / TASK-036) — pure, unit-testable. Decides an id's fate from its current
// booking BEFORE touching the DB: PENDING → proceed to the real single-confirm; already confirmed/attended →
// idempotent no-op; anything else (or missing) → skipped, so a bulk call can never un-cancel a booking.
import type { BulkConfirmOutcome } from "../types/contract";

export type BulkPreCheck =
  | { proceed: true }
  | { proceed: false; outcome: Exclude<BulkConfirmOutcome, "confirmed">; reason?: string };

export function preCheckBulkConfirm(booking: { status: string } | null | undefined): BulkPreCheck {
  if (!booking) return { proceed: false, outcome: "skipped", reason: "ไม่พบคาบเรียน" };
  if (booking.status === "PENDING") return { proceed: true };
  if (booking.status === "CONFIRMED" || booking.status === "ATTENDED")
    return { proceed: false, outcome: "already_confirmed" };
  return { proceed: false, outcome: "skipped", reason: "ไม่ใช่คาบที่รอยืนยัน" };
}
