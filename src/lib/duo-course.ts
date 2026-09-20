// TASK-420 (REQ-095 §13, SPEC-085 B) — DUO = ONE course, TWO kids. The few pure rules every reader shares: what a
// course's kind IS (derived from `co_student_id`, never a stored label), which child ids a row names, how the two
// names print, the family's "my rows" predicate for the LIFF reads, and the refusals.
import { inArray, or, type SQL } from "drizzle-orm";
import { bookings } from "../db/schema";
import { ApiException } from "./http";

export type CourseKind = "DUO" | "PRIVATE";

/** Derived, never stored: a course with a second child is DUO. */
export const courseKindOf = (c: { coStudentId?: string | null } | null | undefined): CourseKind => (c?.coStudentId ? "DUO" : "PRIVATE");

/** The child ids a row (or course) names — the primary first, the co-student when present, never a null. */
export const duoStudentIds = (r: { studentId?: string | null; coStudentId?: string | null } | null | undefined): string[] =>
  [r?.studentId ?? null, r?.coStudentId ?? null].filter((x): x is string => !!x);

/** `Ploy & Pun` — the reminder's and the picker's one spelling for two kids (nickname first, like every family print). */
export function joinChildNames(...kids: Array<{ name: string; nickname?: string | null } | null | undefined>): string {
  return kids.filter((k): k is { name: string; nickname?: string | null } => !!k).map((k) => k.nickname || k.name).join(" & ");
}

/** The family's rows: the child is the primary OR the co-student. ONE predicate for both LIFF windows (TASK-316's rule:
 *  who the family IS must not be able to differ between the two reads). */
export const familyRowsWhere = (studentIds: string[]): SQL =>
  or(inArray(bookings.studentId, studentIds), inArray(bookings.coStudentId, studentIds))!;

export const NOT_DUO = () => new ApiException(400, "NOT_DUO", "ไม่ใช่คอร์ส DUO");
export const DUO_SAME_CHILD = () => new ApiException(400, "DUO_SAME_CHILD", "เด็กสองคนในคอร์ส DUO ต้องเป็นคนละคน");
