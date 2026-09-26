// TASK-486 (REQ-109 §3/§5/§6) — THE teacher schedule format, ONE formatter for every teacher schedule message: the
// `ตารางของฉัน` reply (today and this week) and the Monday digest's body. A coach reads both on the same Monday, and two
// implementations of one format diverge within the month — so there is exactly one.
//
// The format is Khwan's sample, byte for byte (REQ-109 §3):
//   ▸ MON / 07/09                 — a day header per day that has something; 3-letter day for EVERY day (§5 answer 2)
//   @ 09:00 / ของขวัญ               — start time only (§B6) / the ONE name rule (`displayNameOf`: a title for GROUP/OTHER, §B5)
//   　FREESKATE / Attended         — U+3000 indent · the program WITHOUT a leading "Private " (§5 answer 3, TEACHER messages
//                                    ONLY — parent messages keep the subject name whole) · the status in ENGLISH (TASK-493)
//   　📝 <note>                    — only when the booking has one (§5 answer 4)
// Days are separated by a blank line. The owner-approved clash note (TASK-453b) stays on the status line, byte-identical
// (§B2: silence in a customer's sample is not an instruction to delete).
import { t, type Lang } from "./line-i18n";
import { hhmm } from "./time";
import { DOW3 } from "./line-v2-lines";
import { weekdayOf } from "./recurring";
import type { bookingStatus } from "../db/schema";

export type BookingStatus = (typeof bookingStatus.enumValues)[number];
export type TeacherView = "today" | "week";

/**
 * 🔴 WHICH sessions a coach sees, per view — a typed Record over the REAL status enum (Sober's ruling, §B3). A tenth status
 * added to `booking_status` is a COMPILE error here, never a silent default: a default is how this bug class comes back.
 * Khwan named four of these nine; the other five are Sober's judgement (EXTENDED, NO_SHOW) and the contract's (the rest),
 * each with its reason:
 */
export const TEACHER_VISIBLE: Record<BookingStatus, Record<TeacherView, boolean>> = {
  CONFIRMED: { today: true, week: true }, // Khwan
  ATTENDED: { today: true, week: true }, // Khwan
  PENDING: { today: true, week: false }, // Khwan: today only
  SICK_LEAVE: { today: true, week: false }, // Khwan: "Leave", today only
  EXTENDED: { today: true, week: true }, // a real, scheduled make-up class — hiding it means a coach does not know they teach
  PENDING_RESCHEDULE: { today: true, week: false }, // a Pending in all but name
  NO_SHOW: { today: true, week: false }, // the day-end turns started classes into ATTENDED or NO_SHOW: today must not shrink
  CANCELLED: { today: false, week: false }, // Khwan §5 answer 5: hidden in both
  PAUSED: { today: false, week: false }, // on hold — nothing to teach
};
export const isTeacherVisible = (status: string, view: TeacherView): boolean =>
  (TEACHER_VISIBLE as Record<string, Record<TeacherView, boolean>>)[status]?.[view] === true;

export interface TeacherSchedRow {
  date: string;
  startTime: string;
  /** `displayNameOf`: a GROUP/OTHER row's title, else the student(s). */
  name: string | null;
  /** The subject's name, raw — `teacherProgram` drops the "Private " prefix at render. `null` for an OTHER row. */
  program: string | null;
  status: string;
  note?: string | null;
  /** TASK-453b — the owner-approved clash suffix, carried from the digest's own derivation. */
  clash?: boolean;
}

/** §5 answer 3 — the program name only, for a TEACHER: a leading "Private " dropped (`Private FREESKATE` → `FREESKATE`). */
export const teacherProgram = (name: string | null | undefined): string | null => {
  const s = name?.trim();
  return s ? s.replace(/^private\s+/i, "") : null;
};

/** `2026-09-07` → `▸ MON / 07/09` — the day in 3 letters for EVERY day (never `SATURDAY`), the date DD/MM. */
export const teacherDayHeader = (iso: string): string => `▸ ${DOW3[weekdayOf(iso)]} / ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * 🔴 TASK-493 — the schedule's WORDS are ENGLISH in EVERY chat, Thai included: the headers and the status words. **This is
 * the customer's own choice, not an oversight** — the owner answered for Khwan (09-26): her coaches read the English labels
 * of her sample more easily. 🚫 Do not "fix" an all-English schedule in a Thai chat back to Thai. The status words are still
 * READ from the shared `status_*` vocabulary (its EN column), so a rename moves every surface together; the Thai column is
 * untouched and still serves the parents' surfaces.
 */
export const TEACHER_SCHEDULE_WORDS: Lang = "EN";

const IND = String.fromCharCode(0x3000); // the ideographic space (U+3000) the sample indents with — built from its CODE, so no editor can "fix" it to a plain space

/**
 * The BODY: the day blocks, filtered by the view's set, sorted by day then time, capped (LINE's size limit). `clashNote` is
 * the digest's approved suffix text, appended to a clashing row's status line when given.
 */
export function renderTeacherScheduleBody(rows: TeacherSchedRow[], view: TeacherView, opts: { cap?: number; clashNote?: string } = {}): { body: string; shown: number; total: number } { // TASK-493 — no language: the body has none
  const visible = rows.filter((r) => isTeacherVisible(r.status, view))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.startTime).localeCompare(String(b.startTime)));
  const cap = opts.cap ?? visible.length;
  const shown = visible.slice(0, cap);
  const blocks: string[] = [];
  let lastDate = "";
  for (const r of shown) {
    if (r.date !== lastDate) {
      if (lastDate) blocks.push("");
      blocks.push(teacherDayHeader(r.date));
      lastDate = r.date;
    }
    blocks.push(`@ ${hhmm(r.startTime)} / ${r.name ?? "-"}`);
    const program = teacherProgram(r.program);
    const status = t(`status_${r.status}`, TEACHER_SCHEDULE_WORDS);
    const clash = r.clash && opts.clashNote ? ` ${opts.clashNote}` : "";
    blocks.push(`${IND}${program ? `${program} / ` : ""}${status}${clash}`);
    if (r.note?.trim()) blocks.push(`${IND}📝 ${r.note.trim()}`);
  }
  return { body: blocks.join("\n"), shown: shown.length, total: visible.length };
}

/**
 * The `ตารางของฉัน` REPLY (today or this week). The header: this week = Khwan's `⏱️ THIS WEEK'S SCHEDULE`; today =
 * `⏱️TODAY'S SCHEDULE:`, KEPT equal to the approved AUTO message's title (§B4). A blank line after the header, as the sample.
 * 🔴 TASK-493 — EVERY word of this message is ENGLISH in every chat (`TEACHER_SCHEDULE_WORDS`, the customer's choice) — the
 * headers, the status words, and (Sober's ruling) the empty line and the "…and N more" line too: ONE message, ONE language.
 * Two Thai sentences inside an English message read as a bug a coach will report. So this takes NO language: nothing in it
 * follows the chat. (The quick-reply CHIPS still do — they are the chat's buttons, not the schedule; see the caller.)
 * `tsched_empty`'s Thai column is untouched: the AUTO "today" message (`line-today-schedule.ts`) still reads it.
 */
export function renderTeacherSchedule(rows: TeacherSchedRow[], view: TeacherView, cap = 20): string {
  const title = t(view === "week" ? "tsched2_title_week" : "tsched_title_today", TEACHER_SCHEDULE_WORDS);
  const { body, shown, total } = renderTeacherScheduleBody(rows, view, { cap });
  if (!shown) return `${title}\n${t("tsched_empty", TEACHER_SCHEDULE_WORDS)}`;
  const more = total > shown ? `\n\n${t("tsched_more", TEACHER_SCHEDULE_WORDS, { count: total - shown })}` : "";
  return `${title}\n\n${body}${more}`;
}
