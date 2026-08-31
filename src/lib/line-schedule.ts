// Teacher "my schedule" text renderer (REQ-016 / TASK-043) — pure (no DB / no LINE API), so it is unit-testable
// and stays bilingual via `t()`.
//
// 🔴 REQ-067 Part B / TASK-175 — rewritten for a phone. It used to be ONE unbroken line per session
// (`{date} {time} · {student} · {subject} · {status}`), which on a phone wraps mid-word and mid-name; a
// teacher checking their week before leaving the house was reading a wall of text. **A message that is
// unreadable is, in practice, the same as being wrong.**
//
// The shape: the week is grouped by DAY with the day named once as a heading, each session leads with the
// TIME (what a teacher scans for), the student on that same line, and program · status indented underneath.
// A blank line separates days. Long lists are still capped so the message cannot exceed LINE's size limit.
import { t, type Lang } from "./line-i18n";
import { hhmm } from "./time";

export interface SchedRow {
  date: string;
  startTime: string;
  /** What NAMES the session — a student's nickname, or an อื่นๆ booking's typed title (TASK-228 / AC-16). */
  studentName: string;
  /** `null` for an อื่นๆ booking, which has no program. The segment is omitted, never printed blank. */
  subjectName: string | null;
  status: string;
  /** TASK-178 (REQ-068) — the attendee note, when the family left one. Absent for almost every session. */
  attendeeNote?: string | null;
}

/** Day names, indexed by `Date.getDay()` (0 = Sunday). Short forms — a heading, not prose. */
const DAY_NAMES: Record<Lang, string[]> = {
  TH: ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"],
  EN: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
};

/** "จันทร์ 30/07" / "Monday 30/07" — the day named, then the date in the short form a phone can hold. */
export function dayHeading(isoDate: string, lang: Lang): string {
  const d = new Date(`${isoDate}T00:00:00`);
  const [, month, day] = isoDate.split("-");
  return `${DAY_NAMES[lang][d.getDay()]} ${day}/${month}`;
}

export function renderSchedule(rows: SchedRow[], lang: Lang, range: "today" | "week", cap = 20): string {
  const title = t(range === "week" ? "tsched_title_week" : "tsched_title_today", lang);
  if (!rows.length) return `${title}\n${t("tsched_empty", lang)}`;

  // Order matters on a schedule in a way it does not in a list: a teacher reads it as a plan for the week, so
  // it is sorted by day then time regardless of how the query returned it.
  const shown = [...rows]
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
    .slice(0, cap);

  const blocks: string[] = [];
  let lastDate = "";
  for (const r of shown) {
    // The day heading appears once per day, and only in the week view — repeating today's date on the today
    // view is noise a teacher has to read past.
    if (range === "week" && r.date !== lastDate) {
      blocks.push(`${lastDate ? "\n" : ""}▸ ${dayHeading(r.date, lang)}`);
      lastDate = r.date;
    }
    blocks.push(
      // Time first: it is the one field a teacher scans for. Student on the same line so the pair reads as one
      // fact; program and status indented under it so a long program name wraps into its own space, not into
      // the next session's.
      `${hhmm(r.startTime)}  ${r.studentName}`,
      // TASK-228 (AC-16): an อื่นๆ booking has NO program, so the segment is dropped rather than rendered as
      // a leading " · " with nothing before it. Same rule as the note below and as TASK-219's: an empty field
      // reads as information that went missing, not as information that does not exist.
      r.subjectName
        ? `   ${r.subjectName} · ${t(`status_${r.status}`, lang)}`
        : `   ${t(`status_${r.status}`, lang)}`,
    );
    // TASK-178 (REQ-068): the note, when there is one — indented under the session it belongs to, so a teacher
    // reads it as part of that class rather than as another line of schedule. A session without a note is
    // byte-identical to before (AC-5): almost every session has none, and a "note: —" placeholder on all of
    // them would cost more attention than the feature is worth.
    if (r.attendeeNote?.trim()) blocks.push(`   📝 ${r.attendeeNote.trim()}`);
  }

  const more = rows.length > cap ? `\n\n${t("tsched_more", lang, { count: rows.length - cap })}` : "";
  return `${title}\n${blocks.join("\n")}${more}`;
}
