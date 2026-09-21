// TASK-423 (REQ-095 §13.3) — the coach rate PER SESSION: the course holds the DEFAULT (`course_packages.class_rate_minor`),
// a COURSE_PACKAGE row may OVERRIDE it (`bookings.teacher_rate_minor` — the same column an OTHER/GROUP row uses for its
// primary teacher's rate; on a course row NULL means "inherit the default"). The rule lives HERE and nowhere else:
// effective = override ?? default. Stored only — nothing posts a rate (the backoffice pass is the owner's decision).
export interface RateFacts {
  effectiveMinor: number | null;
  overrideMinor: number | null;
  defaultMinor: number | null;
}

type Row = { bookingType?: string | null; teacherRateMinor?: number | null } | null | undefined;
type Course = { classRateMinor?: number | null } | null | undefined;

/** `override ?? default ?? null` — the ONE place the rule is written. */
export const effectiveRateMinor = (row: Row, course: Course): number | null => row?.teacherRateMinor ?? course?.classRateMinor ?? null;

/** The DTO's three facts — non-null ONLY for a COURSE_PACKAGE row (an OTHER/GROUP row's rate is `other.teacherRates`;
 *  the two meanings never share a key). */
export function rateFacts(row: Row, course: Course): RateFacts | null {
  if (row?.bookingType !== "COURSE_PACKAGE") return null;
  return { effectiveMinor: effectiveRateMinor(row, course), overrideMinor: row?.teacherRateMinor ?? null, defaultMinor: course?.classRateMinor ?? null };
}
