// SPEC-042 / TASK-134 (REQ-053) — a course is ONE program, fixed when the course is created. There is no
// subject column on `course_packages`: the program is derived from `bookings[0].subject`
// (`mappers.ts` / `scheduler.service.ts`), so letting one session's subject change silently re-brands the
// whole course (the REQ-013/REQ-014 corruption class). The FE hides the field; this is the actual rule.
//
// Scope is COURSE_PACKAGE sessions only (`courseId != null`) — voucher / single / trial sessions may
// legitimately carry a chosen program (SPEC-026/030) and are untouched.

export const COURSE_SUBJECT_LOCKED = "COURSE_SUBJECT_LOCKED";
export const COURSE_SUBJECT_LOCKED_MESSAGE = "A course session's subject cannot be changed";

/** true = this edit would change a course session's subject and must be refused. A no-op (same subjectId,
 *  or no subjectId in the patch) passes, so re-sending an unchanged payload stays idempotent. */
export const changesCourseSubject = (
  current: { subjectId: string; courseId: string | null },
  requestedSubjectId: string | null | undefined,
): boolean => !!requestedSubjectId && current.courseId != null && requestedSubjectId !== current.subjectId;
