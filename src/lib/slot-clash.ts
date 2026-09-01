// REQ-078 AC-24 (revised) / TASK-238 — what a slot-clash refusal says.
//
// 🔴 The owner's ruling (DEF-2, option ข): **overlap stays refused.** Honouring "warn, don't block" would need
// the calendar to SHOW two things in one slot, and without that we would ship invisible double-bookings —
// worse than the refusal we started with. So the capability is a follow-up REQ and **only the message changes**.
//
// Why the message matters enough to have its own file: the staff member's next action is *pick another time*,
// and `"ครูมีคาบในช่วงเวลานี้แล้ว"` does not tell them **which** teacher or **what** is already there. They have
// to go and look — on the screen that just refused them. The refusal should carry the two facts that decide
// their next click.
//
// Pure — no DB, no clock — so the exact wording is testable without a database.

export interface SlotClash {
  /** The teacher who is already busy — nickname preferred, it is what staff call them. */
  teacherName: string;
  /** The clashing booking's `displayName` (TASK-224): a student's nickname, or an อื่นๆ booking's typed title. */
  bookingName: string;
  /** `HH:mm`, or `HH:mm-HH:mm` when the end is known. */
  time: string;
}

/**
 * The AC-24 sentence, verbatim from the REQ:
 *
 *   `ครู{ชื่อ} มีคาบสอนช่วงเวลานี้อยู่แล้ว ({ชื่อคาบ} {เวลา}) กรุณาเลือกเวลาอื่น`
 *
 * 🔴 The booking name is `displayName`, never the word "อื่นๆ" — an อื่นๆ booking blocking another one names
 * the admin's typed title, which is the entire reason they are asked to type it (REQ-078 📌).
 */
export const slotClashMessage = (c: SlotClash): string =>
  `ครู${c.teacherName} มีคาบสอนช่วงเวลานี้อยู่แล้ว (${c.bookingName} ${c.time}) กรุณาเลือกเวลาอื่น`;

/**
 * The generic refusal, kept for the case where the clash cannot be identified.
 *
 * ⚠️ It is a **fallback, not a default**. A lookup can legitimately come back empty — the occupant may have been
 * cancelled in the moment between the insert failing and the lookup running. Refusing with less detail is
 * correct there; **inventing a teacher or a booking name would be worse than the generic sentence.**
 */
export const GENERIC_SLOT_TAKEN = "ครูมีคาบในช่วงเวลานี้แล้ว";
