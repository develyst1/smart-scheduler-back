// TASK-441 (REQ-104 §2 item 2 / §3) — the Monday weekly coach digest, the PURE half: the Mon–Sun window of a run date, the
// per-teacher grouping (primary AND additional — the daily reminder's rule), the send-once key, and the ENGLISH-ONLY render.
//
// 🔴 English only, by the owner's ruling: this kind takes NO `t()` and NO `lang` — its bytes are the constants below, and the
// suite pins that the output carries no Thai code point under either `line_lang`. There is no per-kind language override
// in `line-i18n.ts` (every key falls back TH → EN), so a constant renderer is the honest shape, not a special case.
import { displayNameOf } from "../db/mappers";
import { isTeacherVisible, renderTeacherScheduleBody } from "./teacher-schedule";
import { CLASH_NOTE_WEEKLY, clashingSlotKeys, liveSeatsOfRow, slotKeyOf } from "./group-clash";
import { addDays, fmtDate, hhmm } from "./time";

export const WEEKLY_DIGEST_JOB = "weekly-teacher-digest";

/** The Mon–Sun week containing `date` (a Tuesday manual run still builds the CURRENT week). */
export function weekOf(date: string): { weekStart: string; weekEnd: string } {
  const d = new Date(`${date}T00:00:00`);
  const back = (d.getDay() + 6) % 7; // Mon → 0 … Sun → 6
  const weekStart = fmtDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

/** Send-once per teacher per week — a second Monday run enqueues nothing twice. */
export const weeklyDigestKey = (teacherId: string, weekStart: string) => `weekly-teacher:${teacherId}:${weekStart}`;

export interface WeekRow {
  date: string; startTime: string; endTime: string | null; program: string | null; studentName: string | null; clash?: boolean;
  /** TASK-486 — the row's status (the digest now shows the WEEK set, not CONFIRMED only), its name and its note. */
  status?: string; name?: string | null; note?: string | null;
  /** TASK-486 — the SUBJECT's name alone (`program` above is title-or-subject, kept for the payload's old readers). */
  subject?: string | null;
}
export interface WeekGroup { teacherId: string; lineUserId: string | null; rows: WeekRow[] }

/**
 * One group per teacher who has ≥ 1 REMINDABLE (CONFIRMED) row in the week — the primary AND every additional teacher
 * (the daily's rule: a coach on a row is on the schedule). A GROUP / OTHER row is ONE line with its title and no student
 * (the coach's week, not the roll). Rows in date + time order. A teacher with nothing ⇒ no group at all.
 */
export function groupWeekRows(rows: Array<any>): WeekGroup[] {
  const byTeacher = new Map<string, WeekGroup>();
  // 🔴 TASK-486 — the WEEK set of the ONE table (`TEACHER_VISIBLE`): CONFIRMED · ATTENDED · EXTENDED. It was CONFIRMED only
  // (`REMINDABLE`), which silently left a coach's EXTENDED make-up classes out of their Monday week.
  const sorted = rows.filter((r) => isTeacherVisible(r.status, "week")).sort((a, b) => a.date.localeCompare(b.date) || String(a.startTime).localeCompare(String(b.startTime)));
  // 🔴 TASK-453b — computed from the WEEK's own rows, by the ONE derivation, keyed on the coach-hour so BOTH the
  // group and the Private that took it carry the note. 🚫 Not a second idea of what a clash is.
  const clashes = clashingSlotKeys(rows, liveSeatsOfRow); // raw `bookings` rows — the live-status set
  for (const r of sorted) {
    const line: WeekRow = {
      date: r.date,
      startTime: hhmm(r.startTime),
      endTime: r.endTime ? hhmm(r.endTime) : null,
      program: r.otherTitle ?? r.subject?.name ?? null,
      studentName: r.otherTitle ? null : displayNameOf(r) || null,
      clash: clashes.has(slotKeyOf(r)),
      status: r.status,
      name: displayNameOf(r) || null,
      note: r.attendeeNote ?? null,
      subject: r.otherTitle ? null : (r.subject?.name ?? null),
    };
    const people: Array<{ id: string; lineUserId: string | null }> = [];
    if (r.teacherId) people.push({ id: r.teacherId, lineUserId: r.teacher?.lineUserId ?? null });
    for (const a of r.additionalTeachers ?? []) if (a?.teacherId && !people.some((p) => p.id === a.teacherId)) people.push({ id: a.teacherId, lineUserId: a.teacher?.lineUserId ?? null });
    for (const p of people) {
      const g = byTeacher.get(p.id) ?? { teacherId: p.id, lineUserId: p.lineUserId, rows: [] };
      g.rows.push(line);
      byTeacher.set(p.id, g);
    }
  }
  return [...byTeacher.values()];
}

/** REQ-104 §3 — the owner's words, ENGLISH ONLY. One line per row: `DD-MM-YYYY · HH:MM-HH:MM · <program> / <student>`. */
export const WEEKLY_TITLE = "📅 THIS WEEK'S SCHEDULE";
export const WEEKLY_GREETING = "Hello, here is your teaching schedule for this week:";
export const WEEKLY_FOOTER = "Please review your schedule.";
/**
 * 🔴 TASK-486 (REQ-109 §6) — the BODY is Khwan's weekly format, from the ONE teacher formatter; the MESSAGE around it keeps
 * the owner's approved title, greeting and footer (REQ-104 §3). 📌 Sober's rule, kept here on purpose: **when a new
 * instruction and an old approved one can both be honoured, honour both — escalate only on a real conflict.** §6 rules on
 * the schedule's FORMAT; the greeting and footer are not the schedule.
 * - English words still (REQ-104 §3: the digest has no chat to follow) — the status words render in "EN".
 * - ⚠️ The old pin "no Thai code point" could not survive her format: her own sample puts THAI student names in the rows.
 *   What stays true, and is pinned, is that the FIXED words carry no Thai.
 * - The clash note (TASK-453b) stays on the status line, byte-identical.
 * - ⚠️ The END time is no longer printed (her sample shows the start only, §B6) — a real reduction, stated for Tanya.
 * A row from a payload queued before this change (no `status`) was CONFIRMED by construction: the old digest held nothing else.
 */
export function renderWeeklySchedule(rows: WeekRow[]): string {
  const body = renderTeacherScheduleBody(
    rows.map((r) => {
      const legacy = r.status === undefined; // queued before TASK-486: program = title-or-subject, studentName = the student
      return {
        date: r.date, startTime: r.startTime, status: r.status ?? "CONFIRMED", note: r.note ?? null, clash: r.clash,
        name: legacy ? (r.studentName ?? r.program) : (r.name ?? null),
        program: legacy ? (r.studentName ? r.program : null) : (r.subject ?? null),
      };
    }),
    "week", { clashNote: CLASH_NOTE_WEEKLY },
  ).body;
  // An empty body adds no line of its own — an empty payload renders byte-identical to before.
  return [WEEKLY_TITLE, WEEKLY_GREETING, "", ...(body ? [body] : []), "", WEEKLY_FOOTER].join("\n");
}
