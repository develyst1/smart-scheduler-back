// DB rows → API DTOs. This is the "ready-to-use" layer: every booking ships with
// its teacher/student/subject/course already embedded so the FE never joins.

import { toCourseSummary } from "../lib/leave";
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
});

const studentRef = (s: any) => ({
  id: s.id,
  name: s.name,
  nickname: s.nickname ?? null,
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
