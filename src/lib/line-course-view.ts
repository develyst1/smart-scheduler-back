// SPEC-071 / TASK-234 (REQ-079 §5 Flow 6, AC-15) — คอร์สของฉัน, as a PARENT reads it.
//
// 🔴 The one genuinely new piece in an otherwise reuse task: nothing customer-facing showed a course before.
// REQ-016's view is the TEACHER's schedule, which answers a different question ("who am I teaching today?")
// from this one ("how much of what I paid for is left?").
//
// It is pure, and it takes an already-built `CourseSummary` rather than a DB row — so the five numbers a family
// reads are **the same numbers staff read**, computed by `toCourseSummary` and not re-derived here. A second
// derivation of "sessions remaining" is how a parent and an admin end up quoting different figures at each
// other, which is the one thing this view must never cause.

import { t, type Lang } from "./line-i18n";

export interface MyCourseRow {
  /** The program — what the family calls the course. */
  subjectName: string | null;
  teacherNickname: string | null;
  /** Purchased size, straight from the summary. */
  size: number;
  usedSessions: number;
  leaveRemaining: number;
  expiryDate: string;
}

/**
 * AC-15's five fields: `คอร์ส · ครู · เหลือ n/N · สิทธิ์ลาเหลือ · วันหมดอายุ`.
 *
 * ⚠️ **"เหลือ" is REMAINING, not used** — `size − usedSessions`. Showing the used count under a label that says
 * "remaining" is the kind of quiet inversion a family only notices when they run out early, and by then they
 * have already planned around the wrong number. Clamped at 0: an over-attended course (possible after an
 * import correction) must read "0 left", never a negative.
 *
 * A missing program or teacher renders as `-` rather than being omitted — an absent field on a money document
 * reads as "the system knows and is not saying".
 */
export function courseLine(c: MyCourseRow, lang: Lang): string {
  const remaining = Math.max(0, c.size - c.usedSessions);
  return t("course_row", lang, {
    course: c.subjectName ?? "-",
    teacher: c.teacherNickname ?? "-",
    remaining: String(remaining),
    total: String(c.size),
    leave: String(c.leaveRemaining),
    expiry: c.expiryDate,
  });
}

/** Just enough of a session to answer "who is teaching this course?". */
export interface CourseSession {
  date: string;
  status: string;
  teacher?: { nickname?: string | null } | null;
}

/**
 * 🔴 SPEC-071 / TASK-234 (SA fix) — the teacher of the **NEXT UPCOMING** session, not the first one ever.
 *
 * A course has no teacher column: TASK-140 put the *program* on the course and deliberately left the teacher on
 * the bookings, **because a course is re-teacherable**. So a course split between two teachers is not an
 * oddity — it is the *normal* result of a re-teacher: old sessions with A, future sessions with B.
 *
 * A parent reading คอร์สของฉัน is asking **"who is teaching my child"**, present tense. The first session
 * answers a question nobody asked, and it is wrong in exactly the case the split exists to represent.
 *
 * Falls back to the most RECENT past session when there is nothing upcoming — a finished course still names the
 * person who taught it, rather than going blank the day the last session is attended.
 *
 * `CANCELLED` sessions are skipped in both directions: a cancelled session is not evidence of who teaches.
 * Pure — `today` is injected, so this never picks up the server's timezone.
 */
export function nextSessionTeacher(sessions: CourseSession[], today: string): string | null {
  const withTeacher = sessions.filter((s) => s.status !== "CANCELLED" && s.teacher?.nickname);
  const upcoming = withTeacher
    .filter((s) => s.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (upcoming) return upcoming.teacher!.nickname!;
  const latestPast = withTeacher.sort((a, b) => b.date.localeCompare(a.date))[0];
  return latestPast?.teacher?.nickname ?? null;
}

/** The whole reply. An empty list says so plainly rather than sending a bare heading. */
export function renderMyCourses(rows: MyCourseRow[], lang: Lang): string {
  if (!rows.length) return t("course_none", lang);
  return [t("course_title", lang), ...rows.map((c) => courseLine(c, lang))].join("\n");
}
