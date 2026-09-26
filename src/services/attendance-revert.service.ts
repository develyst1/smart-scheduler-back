// TASK-497 — "this attendance was set by mistake, put it back": the WRITES, shared by the two doors that mean it.
//
// Door 1 — TASK-492's admin Undo of a parent's CHECK-IN (`undoBooking`): parent channels only, an unsettled day only.
// Door 2 — TASK-258's attendance correction (`updateBookingStatus(…, "sick-leave")` on an ATTENDED row): ANY mark (a staff
// mark, the day-end's, a parent's check-in), ANY date — its whole purpose is correcting a past mark.
// 🔑 The doors keep their OWN entry rules (they are different acts to different people); what they share is what "put it back"
// writes, so the two can never diverge on it:
//  · the GUARDED flip: `… WHERE id = $1 AND status = <the status it was read with>` → CONFIRMED, the row's check-in columns
//    cleared (the provenance moves to the event). Zero rows ⇒ something else changed it first ⇒ refused, nothing written;
//  · the unit returned: the exact inverse of `attend`, floored, in `sql` (never read-modify-write);
//  · the EVENT (`booking_undos`, append-only) — which is ALSO what keeps the day-end from re-attending the row that night
//    (`notUndoneAttendance`): without it a CONFIRMED row on its own date is marked ATTENDED again, the unit taken again and the
//    deduction message sent (TASK-497's finding: the old SICK_LEAVE label was, by accident, what protected it).
import { and, eq, sql } from "drizzle-orm";
import { bookingUndos, bookings, coursePackages, vouchers } from "../db/schema";
import { UNDO_ALREADY_CHANGED } from "../lib/booking-undo";

export type AttendanceRow = {
  id: string;
  status: string;
  courseId?: string | null;
  voucherId?: string | null;
  course?: unknown;
  voucher?: unknown;
  checkinChannel?: string | null;
  checkinActor?: string | null;
};

/** The guarded flip back to CONFIRMED + the unit returned. `alsoSet` rides the SAME conditional update (Door 2's note). */
export async function revertAttendance(tx: any, row: AttendanceRow, alsoSet: Record<string, unknown> = {}): Promise<void> {
  const flipped = await tx
    .update(bookings)
    .set({ ...alsoSet, status: "CONFIRMED", checkinSource: null, checkinChannel: null, checkinActor: null }) // the provenance moves to the event
    .where(and(eq(bookings.id, row.id), eq(bookings.status, row.status as (typeof bookings.$inferSelect)["status"])))
    .returning({ id: bookings.id });
  if (!flipped.length) throw UNDO_ALREADY_CHANGED();
  if (row.courseId && row.course) {
    await tx.update(coursePackages).set({ usedSessions: sql`GREATEST(${coursePackages.usedSessions} - 1, 0)` }).where(eq(coursePackages.id, row.courseId));
  }
  if (row.voucherId && row.voucher) {
    await tx.update(vouchers).set({ usedHours: sql`GREATEST(${vouchers.usedHours} - 1, 0)` }).where(eq(vouchers.id, row.voucherId));
  }
}

/** THE EVENT, append-only — who, why, what the row was (with the original check-in's provenance), what came back. */
export async function recordUndo(
  tx: any,
  row: AttendanceRow,
  event: {
    kind: "leave" | "checkin" | "attendance";
    undoneBy: string | null;
    reason: string | null;
    leaveRefunded?: boolean;
    makeupCancelledId?: string | null;
    expiryFrom?: string | null;
    expiryTo?: string | null;
  },
): Promise<void> {
  await tx.insert(bookingUndos).values({
    bookingId: row.id,
    kind: event.kind,
    undoneBy: event.undoneBy,
    reason: event.reason,
    priorStatus: row.status,
    priorCheckinChannel: row.checkinChannel ?? null,
    priorCheckinActor: row.checkinActor ?? null,
    leaveRefunded: event.leaveRefunded ?? false,
    makeupCancelledId: event.makeupCancelledId ?? null,
    expiryFrom: event.expiryFrom ?? null,
    expiryTo: event.expiryTo ?? null,
  });
}
