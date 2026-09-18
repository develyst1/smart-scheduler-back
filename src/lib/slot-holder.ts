// TASK-397 (REQ-095 Stage 2a) — "does this booking HOLD a teacher's slot?" — the ONE definition, in code, of the
// partial unique index `bookings_teacher_slot_uq` (schema.ts): a live status (`SLOT_INACTIVE_STATUSES`, TASK-239 /
// TASK-260) AND not a seat (`group_id IS NULL` — a seat's GROUP row holds the slot, the seat does not).
//
// 🔴 Every availability read mirrors the index THROUGH THIS FILE: `describeSlotClash`, `assertAdditionalTeacherFree`,
// `findFreeExtensionDate` (make-up / extension placement) and `getSlotAvailability` (the picker). Two definitions is
// how a refusal and the index it mirrors drift — and they HAD drifted: `lib/booking-slot.ts` carried a second list
// (`SLOT_NON_BLOCKING`, three statuses, no PAUSED) that only the picker read, so a PAUSED booking showed as BOOKED
// there while the index (and the other three reads) freed it. Retired here; this file is the only answer now.
import { and, isNull, notInArray, type SQL } from "drizzle-orm";
import { SLOT_INACTIVE_STATUSES } from "../db/schema";

export { SLOT_INACTIVE_STATUSES };

/** The SQL predicate — pass the `bookings` table (or a relational `b`). */
export const slotHolderWhere = (b: { status: any; groupId: any }): SQL =>
  and(notInArray(b.status, [...SLOT_INACTIVE_STATUSES]), isNull(b.groupId))!;

/** The pure mirror: `true` = this row holds its (teacher, date, startTime) slot — it would clash a new booking. */
export const holdsSlot = (row: { status: string; groupId?: string | null }): boolean =>
  !(SLOT_INACTIVE_STATUSES as readonly string[]).includes(row.status) && row.groupId == null;
