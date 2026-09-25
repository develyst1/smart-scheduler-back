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

import { tb } from "./line-i18n";
import { courseLineV2, joinItems } from "./line-v2-lines";

export interface MyCourseRow {
  /** 🔴 TASK-470 — whose course it is, through the ONE name rule (`studentNamesOf`): her line leads with it. */
  studentName: string | null;
  /** The program — what the family calls the course. */
  subjectName: string | null;
  teacherNickname: string | null;
  /** Purchased size, straight from the summary. */
  size: number;
  usedSessions: number;
  leaveRemaining: number;
  expiryDate: string;
}

// 🔻 TASK-470 — the old `courseLine` (AC-15's five fields incl. the leave quota) is gone: the customer's format replaced it
// (`courseLineV2`, `line-v2-lines.ts`) and nothing else called it. Its claims — REMAINING not used, clamped at 0, a missing field
// printed as `-` — moved with it and are pinned on the new line. The `course_row` i18n key stays: another suite pins it as a
// shared label pattern.

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

/**
 * The whole reply. An empty list says so plainly rather than sending a bare heading.
 * 🔴 TASK-470 — the customer's format: `My Course:` / `คอร์สของฉัน :`, then one line per course with a BLANK LINE between
 * (`courseLineV2`): the name, the program, the teacher, what REMAINS and when it EXPIRES — and 🚫 no leave quota (her note:
 * "เอาสิทธิการลาออกค่ะ"; the MESSAGE only — the quota is still on every staff screen and in `toCourseSummary`).
 * 🔑 Sober's ruling (TASK-470 f): the HEADING is bilingual, the class LINES are printed ONCE. TASK-276 prints both
 * languages so either parent can READ a message; her line has no translated word in it, so printing it once per
 * language only doubled the scroll. Words stay bilingual (the heading, "no courses"); data-only lines do not.
 */
export function renderMyCourses(rows: MyCourseRow[]): string {
  if (!rows.length) return tb("course_none");
  return `${tb("course_title")}\n${joinItems(rows.map((c) => courseLineV2(c)))}`;
}
