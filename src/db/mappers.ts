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
  subjects: (t.teacherSubjects ?? []).map((ts: any) => ({
    id: ts.subject.id,
    name: ts.subject.name,
  })),
  lineLinked: !!t.lineUserId,
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

export const toBookingDTO = (b: any) => ({
  id: b.id,
  date: b.date,
  startTime: hhmm(b.startTime),
  endTime: hhmm(b.endTime),
  bookingType: b.bookingType,
  status: b.status,
  note: b.note ?? null,
  student: studentRef(b.student),
  teacher: toTeacherBase(b.teacher),
  subject: { id: b.subject.id, name: b.subject.name },
  course: b.course ? toCourseSummary(b.course) : null,
  badges: (b.badges ?? []).map(toBookingBadge),
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
});

export const toVoucherDTO = (v: any) => ({
  id: v.id,
  totalHours: v.totalHours,
  usedHours: v.usedHours,
  remaining: voucherRemaining(v),
  expiryDate: v.expiryDate,
  student: studentRef(v.student),
});
