// SPEC-066 / TASK-208 (REQ-072 part 3B) — who gets a "you have a class today" message, and what is in it.
//
// 🔴 **One message per PERSON, never per booking.** A Saturday is ~60 sessions: per-booking would send one
// teacher eight separate pushes before 08:20 and a two-child parent two. That is how a notification channel
// gets muted, and a muted channel is worse than no channel — this is the same non-negotiable the confirm
// messages are built on.
//
// The message body is deliberately NOT invented here: it is the `ตารางวันนี้` composer the owner has already
// read on a real phone (`renderSchedule`). This file decides **who** and **which rows**; the wording stays
// where it was verified.
//
// Pure — no DB, no clock.

import type { SchedRow } from "./line-schedule";

export interface ReminderSession {
  id: string;
  date: string;
  startTime: string;
  status: string;
  teacherId: string | null;
  teacherLineUserId: string | null;
  studentId: string | null;
  studentName: string;
  parentId: string | null;
  parentLineUserId: string | null;
  subjectName: string;
}

export interface ReminderGroup {
  recipientType: "teacher" | "parent";
  /** Who this is about — the teacher or the parent. Used only to key the group; never sent. */
  personId: string;
  lineUserId: string | null;
  rows: SchedRow[];
}

/** Statuses that mean "there is a class today". A cancelled or leave row must never produce a reminder. */
const REMINDABLE = new Set(["PENDING", "CONFIRMED", "EXTENDED"]);

/**
 * Group today's sessions into **one entry per person** — every teacher who teaches today, every parent whose
 * child has a class today.
 *
 * A parent with two children gets **one** message listing both, which is why the parent grouping is keyed on
 * the parent and not on the student. An unlinked person still produces a group (with `lineUserId: null`) so
 * the caller can write a SKIPPED row and **count the reach**: on `uat` most parents were imported and have
 * never linked, and a feature that silently reaches nobody is the `sale:ensure-items` lesson.
 */
export function groupReminders(sessions: ReminderSession[]): ReminderGroup[] {
  const live = sessions.filter((s) => REMINDABLE.has(s.status));
  const byTeacher = new Map<string, ReminderGroup>();
  const byParent = new Map<string, ReminderGroup>();

  for (const s of live) {
    const row: SchedRow = {
      date: s.date,
      startTime: s.startTime,
      studentName: s.studentName,
      subjectName: s.subjectName,
      status: s.status,
    };
    if (s.teacherId) {
      const g = byTeacher.get(s.teacherId) ?? {
        recipientType: "teacher" as const,
        personId: s.teacherId,
        lineUserId: s.teacherLineUserId,
        rows: [],
      };
      g.rows.push(row);
      byTeacher.set(s.teacherId, g);
    }
    if (s.parentId) {
      const g = byParent.get(s.parentId) ?? {
        recipientType: "parent" as const,
        personId: s.parentId,
        lineUserId: s.parentLineUserId,
        rows: [],
      };
      g.rows.push(row);
      byParent.set(s.parentId, g);
    }
  }

  // Sorted within each person so the message reads as a day, not as a query result.
  for (const g of [...byTeacher.values(), ...byParent.values()]) {
    g.rows.sort((a, b) => a.startTime.localeCompare(b.startTime));
  }
  return [...byTeacher.values(), ...byParent.values()];
}

/**
 * The reach, counted **before** anything is sent — the number that says whether this feature does anything at
 * all today. `unlinkedParents` is the one to watch: it is large on `uat` by construction.
 */
export const reminderReach = (groups: ReminderGroup[]) => ({
  teachers: groups.filter((g) => g.recipientType === "teacher").length,
  parents: groups.filter((g) => g.recipientType === "parent").length,
  unlinkedTeachers: groups.filter((g) => g.recipientType === "teacher" && !g.lineUserId).length,
  unlinkedParents: groups.filter((g) => g.recipientType === "parent" && !g.lineUserId).length,
  sessions: groups.reduce((n, g) => n + (g.recipientType === "teacher" ? g.rows.length : 0), 0),
});
