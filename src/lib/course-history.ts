// SPEC-035 / TASK-119 (REQ-038 #5) — "ประวัติการตัดคอร์ส". A read-only chronological timeline RECONSTRUCTED from
// existing durable rows (no new table): the course's bookings (all statuses) + the freelance-ledger `bo.movement`
// entries for those bookings. Pure — the service loads + maps refs, this assembles + derives kinds + orders.
//
// Two honest limits, encoded not hidden (SPEC-035 §1): (1) no ACTOR — one shared login today, so every event's
// `actor` is null until separate logins exist; (2) only the CURRENT status per booking is known — intermediate
// hops (CONFIRMED→SICK_LEAVE→ATTENDED) aren't logged; that's Tier 2 (`booking_events`), deferred.

import { COURSE_DELIVERED, deriveLiveEndDate } from "./course-plan";

export type HistoryKind =
  | "attended"
  | "no-show"
  | "cancelled"
  | "sick-leave"
  | "makeup-appended"
  | "extra-session-added"
  | "scheduled"
  | "freelance-drawn"
  | "freelance-refunded"
  /** SPEC-064 / TASK-181 (REQ-036) — the course was ended early. One event, carrying reason + note + actor. */
  | "course-ended";

export interface HistoryBookingInput {
  id: string;
  status: string;
  bookingType: string;
  date: string;
  extendedFromId: string | null;
  note: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  teacher?: unknown;
  subject?: unknown;
}

export interface HistoryMovementInput {
  refId: string | null;
  refType: string | null;
  qty: number;
  valueMinor: number;
  createdAt: string; // ISO
}

/**
 * Kind for a booking event. A `SINGLE_SESSION` soft-linked to the course is the paid extra (REQ-037); an `EXTENDED`
 * is a re-owed makeup; otherwise the status maps directly. LIVE-but-unconsumed rows are `scheduled`.
 */
export function bookingEventKind(b: { status: string; bookingType: string }): HistoryKind {
  if (b.bookingType === "SINGLE_SESSION") return "extra-session-added";
  switch (b.status) {
    case "ATTENDED":
      return "attended";
    case "NO_SHOW":
      return "no-show";
    case "CANCELLED":
      return "cancelled";
    case "SICK_LEAVE":
      return "sick-leave";
    case "EXTENDED":
      return "makeup-appended";
    default:
      return "scheduled"; // CONFIRMED / PENDING / PENDING_RESCHEDULE
  }
}

/** Kind for a freelance-ledger movement — `BOOKING` = a draw, `BOOKING_REVERSAL` = a refund. Any other movement
 *  (e.g. a `SALE` revenue post) is not part of the deduction history → `null` (excluded). */
export function movementEventKind(refType: string | null): "freelance-drawn" | "freelance-refunded" | null {
  if (refType === "BOOKING") return "freelance-drawn";
  if (refType === "BOOKING_REVERSAL") return "freelance-refunded";
  return null;
}

export interface HistoryEvent {
  at: string;
  kind: HistoryKind;
  sessionDate?: string;
  status?: string;
  teacher?: unknown;
  subject?: unknown;
  reason?: string | null;
  makeupOfDate?: string | null;
  valueMinor?: number;
  /** TASK-181 (REQ-036) — the closed reason a course was ended early, distinct from the free-text `reason`
   *  above so the FE can label it and a query can count it. */
  endReason?: string | null;
  actor: null; // SPEC-035 §1 limit #1 — not recorded (shared login)
}

export interface CourseHistory {
  summary: {
    size: number;
    usedSessions: number;
    leaveUsed: number;
    remaining: number;
    liveEndDate: string | null;
  };
  events: HistoryEvent[];
}

/** Assemble the ordered timeline + header summary. `at` = when the shown thing happened: for an *added* row
 *  (makeup/extra) that's `createdAt`; for a status the row reached, `updatedAt` (the only per-booking change time). */
export function buildCourseHistory(
  course: {
    size: number;
    leaveUsed: number;
    // TASK-181 (REQ-036): set when the course was ended early — surfaced as its own event (AC-3/AC-6).
    endedAt?: Date | string | null;
    endReason?: string | null;
    endNote?: string | null;
    endedBy?: string | null;
  },
  bookings: HistoryBookingInput[],
  movements: HistoryMovementInput[],
): CourseHistory {
  const dateById = new Map(bookings.map((b) => [b.id, b.date]));
  const events: HistoryEvent[] = [];

  for (const b of bookings) {
    const kind = bookingEventKind(b);
    const isAdd = kind === "makeup-appended" || kind === "extra-session-added";
    events.push({
      at: isAdd ? b.createdAt : b.updatedAt,
      kind,
      sessionDate: b.date,
      status: b.status,
      teacher: b.teacher,
      subject: b.subject,
      reason: b.note ?? null,
      makeupOfDate: b.extendedFromId ? dateById.get(b.extendedFromId) ?? null : undefined,
      actor: null,
    });
  }

  for (const m of movements) {
    const kind = movementEventKind(m.refType);
    if (!kind) continue; // not a freelance-ledger movement
    events.push({
      at: m.createdAt,
      kind,
      sessionDate: m.refId ? dateById.get(m.refId) : undefined,
      valueMinor: m.valueMinor,
      actor: null,
    });
  }

  // TASK-181 (REQ-036): the ending is a fact about the COURSE, not about any one session, so it is pushed
  // here rather than derived from the cancelled rows — which would read as N separate cancellations with no
  // reason attached and no way to tell them from an ordinary one.
  //
  // `actor` stays null like every other event (SPEC-035 §1 — one shared login makes a name meaningless on
  // screen). Who ended it IS recorded, in `course_packages.ended_by`, and stays answerable by query.
  if (course.endedAt) {
    events.push({
      at: typeof course.endedAt === "string" ? course.endedAt : course.endedAt.toISOString(),
      kind: "course-ended",
      reason: course.endNote ?? null,
      endReason: course.endReason ?? null,
      actor: null,
    });
  }

  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  // Only COURSE_PACKAGE rows count toward the course's own usage (SPEC-033 seam — an extra is separate).
  const coursePackage = bookings.filter((b) => b.bookingType === "COURSE_PACKAGE");
  const usedSessions = coursePackage.filter((b) => COURSE_DELIVERED.has(b.status)).length;

  return {
    summary: {
      size: course.size,
      usedSessions,
      leaveUsed: course.leaveUsed,
      remaining: course.size - usedSessions,
      liveEndDate: deriveLiveEndDate(coursePackage),
    },
    events,
  };
}
