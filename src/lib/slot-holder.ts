// TASK-397 (REQ-095 Stage 2a) — "does this booking HOLD a teacher's slot?" — the ONE definition, in code, of the
// partial unique index `bookings_teacher_slot_uq` (schema.ts): a live status (`SLOT_INACTIVE_STATUSES`, TASK-239 /
// TASK-260) AND not a seat (`group_id IS NULL` — a seat's GROUP row holds the slot, the seat does not).
//
// 🔴 Every availability read mirrors the index THROUGH THIS FILE: `describeSlotClash`, `assertAdditionalTeacherFree`,
// `findFreeExtensionDate` (make-up / extension placement) and `getSlotAvailability` (the picker). Two definitions is
// how a refusal and the index it mirrors drift — and they HAD drifted: `lib/booking-slot.ts` carried a second list
// (`SLOT_NON_BLOCKING`, three statuses, no PAUSED) that only the picker read, so a PAUSED booking showed as BOOKED
// there while the index (and the other three reads) freed it. Retired here; this file is the only answer now.
//
// 🔴 TASK-453 (REQ-105 §3) — the THIRD case: `AND slot_yielded_at IS NULL`. A GROUP row that yielded its coach-hour to
// a Private booked into an EMPTY group date holds nothing, which is what makes the Private storable at all. The
// index's own WHERE moved with it in `0054`, and the three spellings of this rule (this file · `schema.ts`'s
// `.where(sql`…`)` · `0054`'s `CREATE UNIQUE INDEX … WHERE`) are asserted EQUAL after normalisation by
// `group-slot-yield-req105.test.ts`. Two of them agreeing is not the property; three of them agreeing is.
import { and, isNull, notInArray, type SQL } from "drizzle-orm";
import { SLOT_INACTIVE_STATUSES } from "../db/schema";

export { SLOT_INACTIVE_STATUSES };

/** The SQL predicate — pass the `bookings` table (or a relational `b`). */
export const slotHolderWhere = (b: { status: any; groupId: any; slotYieldedAt: any }): SQL =>
  and(notInArray(b.status, [...SLOT_INACTIVE_STATUSES]), isNull(b.groupId), isNull(b.slotYieldedAt))!;

/**
 * The pure mirror: `true` = this row holds its (teacher, date, startTime) slot — it would clash a new booking.
 *
 * ⚠️ TASK-453 — **stated, not implied: this function has no product caller today.** Every availability read goes
 * through `slotHolderWhere` (SQL); `holdsSlot` is the readable statement of the same rule, exercised by the suite.
 * It gains the third case because a mirror that is right for two reasons out of three is worse than no mirror — but
 * nothing in the product is guarded by it, and no reader should assume otherwise.
 */
export const holdsSlot = (row: { status: string; groupId?: string | null; slotYieldedAt?: Date | string | null }): boolean =>
  !(SLOT_INACTIVE_STATUSES as readonly string[]).includes(row.status) && row.groupId == null && row.slotYieldedAt == null;
