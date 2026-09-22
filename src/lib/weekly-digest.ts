// TASK-441 (REQ-104 §2 item 2 / §3) — the Monday weekly coach digest, the PURE half: the Mon–Sun window of a run date, the
// per-teacher grouping (primary AND additional — the daily reminder's rule), the send-once key, and the ENGLISH-ONLY render.
//
// 🔴 English only, by the owner's ruling: this kind takes NO `t()` and NO `lang` — its bytes are the constants below, and the
// suite pins that the output carries no Thai code point under either `line_lang`. There is no per-kind language override
// in `line-i18n.ts` (every key falls back TH → EN), so a constant renderer is the honest shape, not a special case.
import { displayNameOf } from "../db/mappers";
import { REMINDABLE } from "./daily-reminder";
import { addDays, ddmmyyyy, fmtDate, hhmm } from "./time";

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

export interface WeekRow { date: string; startTime: string; endTime: string | null; program: string | null; studentName: string | null }
export interface WeekGroup { teacherId: string; lineUserId: string | null; rows: WeekRow[] }

/**
 * One group per teacher who has ≥ 1 REMINDABLE (CONFIRMED) row in the week — the primary AND every additional teacher
 * (the daily's rule: a coach on a row is on the schedule). A GROUP / OTHER row is ONE line with its title and no student
 * (the coach's week, not the roll). Rows in date + time order. A teacher with nothing ⇒ no group at all.
 */
export function groupWeekRows(rows: Array<any>): WeekGroup[] {
  const byTeacher = new Map<string, WeekGroup>();
  const sorted = rows.filter((r) => REMINDABLE.has(r.status)).sort((a, b) => a.date.localeCompare(b.date) || String(a.startTime).localeCompare(String(b.startTime)));
  for (const r of sorted) {
    const line: WeekRow = {
      date: r.date,
      startTime: hhmm(r.startTime),
      endTime: r.endTime ? hhmm(r.endTime) : null,
      program: r.otherTitle ?? r.subject?.name ?? null,
      studentName: r.otherTitle ? null : displayNameOf(r) || null,
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
export function renderWeeklySchedule(rows: WeekRow[]): string {
  const lines = rows.map((r) => {
    const time = `${r.startTime}${r.endTime ? `-${r.endTime}` : ""}`;
    const who = [r.program, r.studentName].filter((x) => x && String(x).trim()).join(" / ");
    return `${ddmmyyyy(r.date)} · ${time}${who ? ` · ${who}` : ""}`;
  });
  return [WEEKLY_TITLE, WEEKLY_GREETING, "", ...lines, "", WEEKLY_FOOTER].join("\n");
}
