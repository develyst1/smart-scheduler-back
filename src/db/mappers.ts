// DB rows → API DTOs. This is the "ready-to-use" layer: every booking ships with
// its teacher/student/subject/course already embedded so the FE never joins.

import { toCourseSummary } from "../lib/leave";
import { voucherRemaining } from "../lib/voucher";
import { hhmm } from "../lib/time";

export const toTeacherBase = (t: any) => ({
  id: t.id,
  name: t.name,
  nickname: t.nickname,
  type: t.type,
});

export const toTeacherDTO = (t: any) => ({
  id: t.id,
  name: t.name,
  nickname: t.nickname,
  type: t.type,
  active: t.active,
  // Guard against a dangling teacher_subjects row (no joined subject) — else `ts.subject.id` throws
  // and crashes the whole endpoint (was the PATCH /api/teachers/availability 500). TASK-029.
  //
  // 🔴 SPEC-061 / TASK-173 (REQ-065): **inactive subjects are dropped here, and only here.** Every program
  // picker in the app (single · course · voucher · trial · plan) renders `teacher.subjectOptions`, which is
  // this field — so `active = false` means "not something to choose", at the cause, for every screen present
  // and future. It is deliberately NOT applied on any read path: a booking made on `1st Trial` last month must
  // still render with that name (AC-3), which is why the row is deactivated and never deleted.
  subjects: (t.teacherSubjects ?? [])
    .filter((ts: any) => ts.subject && ts.subject.active !== false)
    .map((ts: any) => ({
      id: ts.subject.id,
      name: ts.subject.name,
    })),
  lineLinked: !!t.lineUserId,
  archived: t.archived ?? false,
  // SPEC-004 money-setup gate: set by attachSetupIncomplete (true = no budget/salary yet → not bookable).
  setupIncomplete: false,
  workDays: (t.workDays ?? [0, 1, 2, 3, 4, 5, 6]).map(Number),
  // Populated from the teacher's backoffice EXPENSE item by attachTeacherQuotas (SPEC-001).
  // All money fields are satang. remainingMinor = current stock; budgetMinor = configured
  // monthly budget; reorderMinor = near-cap warning threshold; overLimit = remainingMinor ≤ 0.
  hourlyRate: null as number | null,
  budgetMinor: null as number | null,
  remainingMinor: null as number | null,
  reorderMinor: null as number | null,
  overLimit: false,
  // Durable admin over-budget override (app_settings). Set by attachLimitOverrides / setLimitOverride.
  limitOverride: false,
});

import { levelName, perksForLevel } from "../lib/crm";

const studentRef = (s: any) => {
  const level = s.crmLevel ?? 1;
  const { priorityBooking, perks } = perksForLevel(level);
  return {
    id: s.id,
    name: s.name,
    nickname: s.nickname ?? null,
    crmPoints: s.crmPoints ?? 0,
    crmLevel: level,
    crmLevelName: levelName(level),
    // UC-020 — สิทธิประโยชน์ตามระดับ (priorityBooking = advisory ให้ staff)
    priorityBooking,
    perks,
  };
};

// Badge value as embedded on a booking (already joined with its type + value).
export const toBookingBadge = (bb: any) => ({
  typeId: bb.badgeTypeId,
  typeName: bb.type?.name ?? null,
  valueId: bb.badgeValueId,
  label: bb.value?.label ?? null,
  color: bb.value?.color ?? null,
});

export const toBadgeValueDTO = (v: any) => ({
  id: v.id,
  typeId: v.badgeTypeId,
  label: v.label,
  color: v.color,
  active: v.active,
  sortOrder: v.sortOrder,
});

export const toBadgeTypeDTO = (t: any) => ({
  id: t.id,
  name: t.name,
  active: t.active,
  sortOrder: t.sortOrder,
  values: (t.values ?? [])
    .slice()
    .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
    .map(toBadgeValueDTO),
});

/**
 * SPEC-070 / TASK-224 (REQ-078 AC-18) — **the one accessor for a booking's teachers.**
 *
 * `bookings.teacher_id` is the first teacher; `booking_teachers` holds the additional ones. 🔴 Nothing outside
 * this function may read either source: two call sites reading two sources is how the two get to disagree, and
 * a booking that shows two teachers on the calendar and one in a report is worse than either answer alone.
 *
 * `teachers[0]` is ALWAYS the row's `teacher_id`, so the order is stable and the existing single-teacher
 * meaning survives everywhere. The four lesson types can never have extras (validation refuses the field, and
 * nothing else writes the table), so this returns exactly one for them — by construction, not by filtering.
 */
export const bookingTeachers = (b: any) => [
  toTeacherBase(b.teacher),
  // `additionalTeachers` is absent when a caller did not load the relation — which is correct for the lesson
  // types and, for `OTHER`, is why the relation lives in the shared `withBookingRelations` rather than being
  // opted into per query.
  ...(b.additionalTeachers ?? [])
    .filter((a: any) => a?.teacher)
    .map((a: any) => toTeacherBase(a.teacher)),
];

export const toBookingDTO = (b: any, opts: { hasRental?: boolean } = {}) => ({
  id: b.id,
  date: b.date,
  startTime: hhmm(b.startTime),
  endTime: hhmm(b.endTime),
  bookingType: b.bookingType,
  status: b.status,
  note: b.note ?? null,
  // SPEC-063 / TASK-178 (REQ-068) — what a parent told us about this session ("พาน้องมาด้วย 2 คน"), distinct
  // from `note` above, which is what the system did to it (cancel reason, auto-extend, leave).
  attendeeNote: b.attendeeNote ?? null,
  // TASK-224 (REQ-078): `null` for an อื่นๆ booking with no student / no program. 🚫 Never a placeholder —
  // REQ-065 exists because `1st Trial` sitting in `subjects` leaked into the program picker and had to be
  // filtered back out. A booking with no program has none, and says so.
  student: b.student ? studentRef(b.student) : null,
  teacher: toTeacherBase(b.teacher),
  subject: b.subject ? { id: b.subject.id, name: b.subject.name } : null,
  // TASK-224 — the typed name of an อื่นๆ booking; `null` on the four lesson types.
  title: b.otherTitle ?? null,
  // 🔴 TASK-224 / AC-10 — the ONE field every surface renders a booking by. Computed for **every** booking
  // type (a 1HR's is its student's nickname, unchanged), so "never blank, never the word อื่นๆ" is a property
  // of this function instead of a fallback re-invented at 31 FE call sites, each free to get it wrong
  // differently. Validation guarantees the inputs: an อื่นๆ booking with no student must carry a title.
  displayName: b.otherTitle ?? b.student?.nickname ?? b.student?.name ?? "",
  // 🔴 TASK-224 / AC-18 — EVERY assigned teacher, from the ONE accessor. Present on every booking type
  // (length 1 for the four lesson types), so the FE has one shape rather than two.
  teachers: bookingTeachers(b),
  course: b.course ? toCourseSummary(b.course) : null,
  badges: (b.badges ?? []).map(toBookingBadge),
  // SPEC-045 / TASK-190 (REQ-052) — does this session have equipment rented against it? A **presence marker**
  // only: the cell shows a glyph, and the rental's detail lives in the ledger, not on a booking.
  //
  // Passed in rather than derived here, because the caller reads it for the whole set in ONE query (a calendar
  // week is ~90 bookings). Defaults to `false`, which is exactly right for the one caller that cannot have
  // rentals: the bookings a course creates, which do not exist until their transaction commits.
  hasRental: opts.hasRental ?? false,
  // SPEC-059 / TASK-171 (REQ-063 req 8 / AC-10) — the discount captured at booking, so the record can answer
  // what/why/who. `null` — not a partly-filled object — when there is no discount: an absent discount and a
  // discount of nothing must not look alike on screen.
  //
  // `value` travels as the HUMAN number it was typed as (percent, or whole baht per TASK-168); the FE formats
  // it. Converting to satang here would put a second unit conversion on the wire, which is the exact shape of
  // the bug this feature has already produced once.
  //
  // ⚠️ `actor` is carried for the record, but per SA it is NOT for the card today: one shared login makes it
  // the same name for everyone, and a meaningless "who" on screen is worse than none. It becomes displayable
  // when per-person logins exist; until then "who" stays answerable from the stored column.
  discount: b.discountKind
    ? {
        kind: b.discountKind,
        value: b.discountValue,
        reason: b.discountReason ?? null,
        actor: b.discountActor ?? null,
      }
    : null,
  // Conflict resolution (B.1) — null/false for ordinary bookings.
  pendingSlot: b.pendingSlot ?? false,
  incomingBookingId: b.incomingBookingId ?? null,
  rescheduleTo: b.rescheduleTo
    ? {
        reason: b.rescheduleTo.reason,
        date: b.rescheduleTo.date,
        teacherId: b.rescheduleTo.teacherId,
        startTime: hhmm(b.rescheduleTo.startTime),
        endTime: hhmm(b.rescheduleTo.endTime),
      }
    : null,
});

export const toCourseWithStudent = (c: any) => ({
  ...toCourseSummary(c),
  student: studentRef(c.student),
  // TASK-140: the course's OWN program (`course_packages.subject_id`) is the source of truth now. The old
  // derivation from `bookings[0].subject` stays as a fallback for rows created before 0018's back-fill ran
  // (and for callers that load bookings but not the subject relation). null when neither is loaded.
  subject: c.subject
    ? { id: c.subject.id, name: c.subject.name }
    : c.bookings?.[0]?.subject
      ? { id: c.bookings[0].subject.id, name: c.bookings[0].subject.name }
      : null,
});

export const toVoucherDTO = (v: any) => ({
  id: v.id,
  totalHours: v.totalHours,
  usedHours: v.usedHours,
  remaining: voucherRemaining(v),
  expiryDate: v.expiryDate,
  student: studentRef(v.student),
});
