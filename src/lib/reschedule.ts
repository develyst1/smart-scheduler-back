// Conflict resolution (B.1) — pure helpers. The DB orchestration lives in the
// service; the slot-end derivation is kept here so it stays framework-free and
// unit-testable (same convention as leave.ts / voucher.ts).

import { addHour } from "./time";

export type RescheduleReason = "MOVE_DAY" | "MOVE_WEEK" | "MOVE_TEACHER";

/** What the FE sends: where to move the overbooked booking (one-hour slot). */
export interface RescheduleResolution {
  reason: RescheduleReason;
  date: string; // YYYY-MM-DD
  teacherId: string;
  startTime: string; // HH:mm
}

/** Stored on the booking + returned to the FE — endTime is derived, never trusted. */
export interface RescheduleTarget extends RescheduleResolution {
  endTime: string; // HH:mm
}

export function buildRescheduleTarget(r: RescheduleResolution): RescheduleTarget {
  return {
    reason: r.reason,
    date: r.date,
    teacherId: r.teacherId,
    startTime: r.startTime,
    endTime: addHour(r.startTime),
  };
}
