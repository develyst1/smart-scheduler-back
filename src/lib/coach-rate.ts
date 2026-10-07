// TASK-423 (REQ-095 §13.3) — the coach rate PER SESSION: the course holds the DEFAULT (`course_packages.class_rate_minor`),
// a COURSE_PACKAGE row may OVERRIDE it (`bookings.teacher_rate_minor` — the same column an OTHER/GROUP row uses for its
// primary teacher's rate; on a course row NULL means "inherit the default"). The rule lives HERE and nowhere else:
// effective = override ?? default. Stored only — nothing posts a rate (the backoffice pass is the owner's decision).
import { ApiException } from "./http";

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

/**
 * TASK-562 (REQ-110 item 5, the owner: "the cover is paid at the COVERING teacher's rate") — the rate teacher `teacherId`
 * already has in an OTHER series: the latest row where they are the primary (`teacherRateMinor`) or an extra (`rateMinor`).
 * `null` when the series has none for them — the caller then REFUSES rather than pay the covered teacher's rate by default.
 * Not a second mechanism: it only READS the per-row rates the series already stores; the cover writes the row's override.
 */
export function seriesRateOf(
  rows: ReadonlyArray<{ date: string; teacherId: string; teacherRateMinor?: number | null; additionalTeachers?: ReadonlyArray<{ teacherId: string; rateMinor?: number | null }> | null }>,
  teacherId: string,
): number | null {
  for (const r of [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))) {
    if (r.teacherId === teacherId && r.teacherRateMinor != null) return r.teacherRateMinor;
    const extra = (r.additionalTeachers ?? []).find((a) => a.teacherId === teacherId && a.rateMinor != null);
    if (extra) return extra.rateMinor!;
  }
  return null;
}

/** ✅ APPROVED by the owner 2026-10-01 — COPY-REVIEW-2026-09-29.md:370 ("all other sections approved as drafted") — wording — a cover with no rate to pay the covering teacher at: say it, never default to the covered one's. */
export const RATE_REQUIRED = (date: string) =>
  new ApiException(400, "RATE_REQUIRED", `วันที่ ${date}: ครูที่มาสอนแทนยังไม่มีค่าสอนในตารางนี้ — กรุณาระบุค่าสอนของครูที่สอนแทน`);
