// Which booking statuses occupy a teacher's slot — the ONE definition, matching the partial unique index
// `bookings_teacher_slot_uq` (schema.ts): a slot is free when its occupant is CANCELLED / PENDING_RESCHEDULE /
// SICK_LEAVE (a teacher on leave frees the slot for a replacement, UC-004). Used by the availability read so it
// can't diverge from what the DB actually enforces at insert.

export const SLOT_NON_BLOCKING = ["CANCELLED", "PENDING_RESCHEDULE", "SICK_LEAVE"] as const;

/** true = this booking holds the (teacher, date, startTime) slot (would clash a new booking). */
export const holdsSlot = (status: string): boolean =>
  !SLOT_NON_BLOCKING.includes(status as (typeof SLOT_NON_BLOCKING)[number]);
