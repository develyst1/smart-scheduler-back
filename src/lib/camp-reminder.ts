// TASK-403 (REQ-095 Stage 3b, SPEC-082) — the camp-day LINE reminder: WHO gets a row and WHAT it carries. Pure, so
// "a teacher on two weeks gets two entries", "a two-device family gets two keys", "an unlinked parent is a SKIPPED
// row that counts the reach" are tests, not live-box hopes. The WORDS are not here (`lib/line-message.ts`,
// `case "camp_reminder"`, PLACEHOLDER labels) and the SEND is not here (the job, behind `camp_reminder_enabled`).
//
// 🚫 It reads `camp_days` rows only — the session reminder's select is REQ-094's byte-frozen one and this never touches it.
import { deviceReminderKey } from "./daily-reminder";

export interface CampDayInput {
  dayId: string;
  weekId: string;
  half: string; // AM | PM | FULL
  status: string;
  studentId: string;
  studentName: string;
  parentId: string | null;
  parentLineUserIds: string[];
}
export interface CampWeekInput {
  id: string;
  name: string;
  status: string;
  teachers: { id: string; lineUserId: string | null }[];
}
/** TASK-405: `date` (the owner's `Date :` line) and the children's `names` (the teacher block lists them, ≤12 then +n — the renderer's rule). */
export interface CampTeacherRow { weekName: string; date: string; total: number; am: number; pm: number; full: number; names: string[] }
export interface CampParentRow { child: string; weekName: string; date: string; half: string }
export interface CampReminderSend {
  recipientType: "teacher" | "parent";
  personId: string;
  lineUserId: string | null;
  key: string;
  payload: { kind: "camp_reminder"; audience: "teacher"; rows: CampTeacherRow[] } | { kind: "camp_reminder"; audience: "parent"; rows: CampParentRow[] };
}

/** Only a PLANNED day is a day to be reminded of (the cut / a mark makes it ATTENDED; CANCELLED is gone). */
export const CAMP_REMINDABLE = new Set(["PLANNED"]);

/** The send-once key — its own prefix, so a family with a session AND a camp day today gets BOTH messages. */
export const campReminderKey = (recipientType: "teacher" | "parent", personId: string, date: string, lineUserId: string | null, primary: string | null) =>
  `camp-${deviceReminderKey(recipientType, personId, date, lineUserId, primary)}`;

/**
 * One send per TEACHER per OPEN week covering today (the head count by half), one per PARENT device with a PLANNED
 * day today (one row per child). A person with no linked account yields ONE row with `lineUserId: null` — the
 * SKIPPED row that counts the reach, as the session reminder does.
 */
export function campReminderSends(days: CampDayInput[], weeks: CampWeekInput[], date: string): CampReminderSend[] {
  const live = days.filter((d) => CAMP_REMINDABLE.has(d.status));
  const weekById = new Map(weeks.map((w) => [w.id, w]));
  const out: CampReminderSend[] = [];

  // teachers: per week, the counts; a teacher on two weeks gets two rows in ONE send
  const byTeacher = new Map<string, { lineUserId: string | null; rows: CampTeacherRow[] }>();
  for (const w of weeks) {
    if (w.status !== "OPEN") continue;
    const mine = live.filter((d) => d.weekId === w.id);
    if (!mine.length) continue;
    const row: CampTeacherRow = { weekName: w.name, date, names: mine.map((d) => d.studentName), total: mine.length, am: mine.filter((d) => d.half === "AM").length, pm: mine.filter((d) => d.half === "PM").length, full: mine.filter((d) => d.half === "FULL").length };
    for (const t of w.teachers) {
      const g = byTeacher.get(t.id) ?? { lineUserId: t.lineUserId ?? null, rows: [] };
      g.rows.push(row);
      byTeacher.set(t.id, g);
    }
  }
  for (const [teacherId, g] of byTeacher) {
    out.push({ recipientType: "teacher", personId: teacherId, lineUserId: g.lineUserId, key: campReminderKey("teacher", teacherId, date, g.lineUserId, g.lineUserId), payload: { kind: "camp_reminder", audience: "teacher", rows: g.rows } });
  }

  // parents: one send per DEVICE, one row per child; the week must still be OPEN
  const byParent = new Map<string, { lineUserIds: string[]; rows: CampParentRow[] }>();
  for (const d of live) {
    if (!d.parentId) continue;
    const w = weekById.get(d.weekId);
    if (!w || w.status !== "OPEN") continue;
    const g = byParent.get(d.parentId) ?? { lineUserIds: d.parentLineUserIds, rows: [] };
    g.rows.push({ child: d.studentName, weekName: w.name, date, half: d.half });
    byParent.set(d.parentId, g);
  }
  for (const [parentId, g] of byParent) {
    const primary = g.lineUserIds[0] ?? null;
    const payload = { kind: "camp_reminder" as const, audience: "parent" as const, rows: g.rows };
    if (!g.lineUserIds.length) { out.push({ recipientType: "parent", personId: parentId, lineUserId: null, key: campReminderKey("parent", parentId, date, null, null), payload }); continue; }
    for (const lineUserId of g.lineUserIds) out.push({ recipientType: "parent", personId: parentId, lineUserId, key: campReminderKey("parent", parentId, date, lineUserId, primary), payload });
  }
  return out;
}
