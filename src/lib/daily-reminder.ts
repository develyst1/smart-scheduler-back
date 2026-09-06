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

import type { TodayRow } from "./line-today-schedule";

export interface ReminderSession {
  id: string;
  date: string;
  startTime: string;
  status: string;
  /**
   * SPEC-072 / TASK-256 — the fields REQ-077 Parent 2 prints beside the time. All optional: a booking whose
   * course was deleted, or an อื่นๆ with no program, must still produce a row rather than vanish from someone's
   * day. `remaining` arrives already rendered — this file decides WHO and WHICH ROWS, never money.
   */
  endTime?: string | null;
  bookingType?: string | null;
  title?: string | null;
  size?: number | null;
  remaining?: string | null;
  expiryDate?: string | null;
  coach?: string | null;
  teacherId: string | null;
  teacherLineUserId: string | null;
  /**
   * SPEC-070 / TASK-228 (AC-16) — the ADDITIONAL teachers of an อื่นๆ booking. Empty (or absent) for the four
   * lesson types, which can never have any. Each one gets the booking on their own schedule: a teacher who is
   * assigned but never told is worse than one who was never assigned.
   */
  additionalTeachers?: { id: string; lineUserId: string | null }[];
  studentId: string | null;
  /**
   * What NAMES this session on the schedule — `displayName` for a booking, so an อื่นๆ session reads as the
   * title the admin typed and every other type reads as the student's nickname, exactly as before.
   */
  studentName: string;
  parentId: string | null;
  parentLineUserId: string | null;
  /** 🔴 TASK-259 — all of the family's accounts. Optional so an older caller still compiles and behaves as before. */
  parentLineUserIds?: string[];
  /** `null` for an อื่นๆ booking, which has no program. `renderSchedule` omits the segment rather than printing a blank. */
  subjectName: string | null;
}

export interface ReminderGroup {
  recipientType: "teacher" | "parent";
  /** Who this is about — the teacher or the parent. Used only to key the group; never sent. */
  personId: string;
  /** The PRIMARY account — `null` when the person has none. Kept for the reach count and the key rule. */
  lineUserId: string | null;
  /** 🔴 TASK-259 — every account this person can be reached on. One for a teacher; several for a family. */
  lineUserIds: string[];
  rows: TodayRow[];
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
    const row: TodayRow = {
      date: s.date,
      startTime: s.startTime,
      studentName: s.studentName,
      subjectName: s.subjectName,
      // TASK-256 — carried through unchanged; the composer decides what to print and what to hoist.
      endTime: s.endTime ?? null,
      bookingType: s.bookingType ?? null,
      title: s.title ?? null,
      size: s.size ?? null,
      remaining: s.remaining ?? null,
      expiryDate: s.expiryDate ?? null,
      coach: s.coach ?? null,
    };
    // TASK-228 (AC-16): EVERY assigned teacher, not just the first. Built as one list so the grouping below
    // is a single loop — a second `if` block for the extras is how one of the two ends up missing a rule the
    // other got (the day the note, or the sort, or the dedupe changes).
    const assigned = [
      ...(s.teacherId ? [{ id: s.teacherId, lineUserId: s.teacherLineUserId }] : []),
      ...(s.additionalTeachers ?? []),
    ];
    for (const teacher of assigned) {
      const g = byTeacher.get(teacher.id) ?? {
        recipientType: "teacher" as const,
        personId: teacher.id,
        lineUserId: teacher.lineUserId,
        // A teacher has exactly one account, so this list is that one or empty — the shape is shared, the
        // behaviour is unchanged.
        lineUserIds: teacher.lineUserId ? [teacher.lineUserId] : [],
        rows: [],
      };
      g.rows.push(row);
      byTeacher.set(teacher.id, g);
    }
    if (s.parentId) {
      const g = byParent.get(s.parentId) ?? {
        recipientType: "parent" as const,
        personId: s.parentId,
        lineUserId: s.parentLineUserIds?.[0] ?? s.parentLineUserId,
        // 🔴 TASK-259 — EVERY account the family has linked. The caller resolves them in bulk (one query for
        // the day, not one per row); this file only carries them.
        lineUserIds: s.parentLineUserIds ?? (s.parentLineUserId ? [s.parentLineUserId] : []),
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
 * TASK-218 — the send-once key for **one person on one business date**, mirroring the day-end sale's
 * `rev:<bookingId>`.
 *
 * 🔴 Why the key is per-RECIPIENT and not per-job: the job used to suppress itself on a `job_runs` flag, so a
 * manual trigger at 07:00 made the real 08:15 run skip and **the day's reminders were silently eaten**. Neither
 * job-level flag can be right — `sent` re-runs all morning on a zero-reach day, `attempted` eats the day. Keyed
 * here, the job may run any number of times: each run sends only to whoever is not already keyed today.
 *
 * The date is the **business date** (Asia/Bangkok), not a timestamp — "one per day" is a calendar statement.
 */
export const reminderKey = (
  recipientType: ReminderGroup["recipientType"],
  personId: string,
  date: string,
) => `reminder:${recipientType}:${personId}:${date}`;

/**
 * 🔴 TASK-259 — the send-once key for ONE DEVICE, now that a family may hold several.
 *
 * The key above identifies a **person**, and while one parent meant one phone the two were the same thing. The
 * moment outbound writes a row per account, a family's two rows would carry one key, the second would hit
 * `notification_outbox_idempotency_uq`, and **the second parent would get nothing — exactly as before, with
 * every test of the accessor still passing.**
 *
 * 🔑 **The primary account keeps the un-suffixed key; every additional device carries its own id.** That is
 * TASK-258's generation-0 rule in another costume, and it buys the same two properties at once:
 *   · a row already queued today under the old format still suppresses the primary's duplicate — **nobody is
 *     messaged twice on the day this deploys**, and
 *   · an additional account's key has never existed before, so it cannot collide with anything.
 *
 * `primaryLineUserId` is `familyLineUserIds`' first element — `parents.line_user_id` when there is one. A
 * teacher has exactly one account, so their key is byte-identical to what it always was.
 */
export const deviceReminderKey = (
  recipientType: ReminderGroup["recipientType"],
  personId: string,
  date: string,
  lineUserId: string | null,
  primaryLineUserId: string | null,
) =>
  lineUserId && lineUserId !== primaryLineUserId
    ? `${reminderKey(recipientType, personId, date)}:${lineUserId}`
    : reminderKey(recipientType, personId, date);

/** One outbox row to write: a person, ONE of their devices, and the key that makes it send once. */
export interface ReminderSend {
  recipientType: ReminderGroup["recipientType"];
  personId: string;
  /** `null` when the person has no linked account — a SKIPPED row, which is how the reach is counted. */
  lineUserId: string | null;
  key: string;
  rows: TodayRow[];
}

/**
 * Expand each person's group into the rows to write — **one per linked account**, or one skipped row when they
 * have none. Pure, so "a two-account family gets two rows with two keys" is a test rather than a live-box hope.
 */
export function reminderSends(groups: ReminderGroup[], date: string): ReminderSend[] {
  return groups.flatMap((g): ReminderSend[] => {
    const primary = g.lineUserIds[0] ?? null;
    if (!g.lineUserIds.length) {
      return [
        {
          recipientType: g.recipientType,
          personId: g.personId,
          lineUserId: null,
          key: reminderKey(g.recipientType, g.personId, date),
          rows: g.rows,
        },
      ];
    }
    return g.lineUserIds.map((lineUserId) => ({
      recipientType: g.recipientType,
      personId: g.personId,
      lineUserId,
      key: deviceReminderKey(g.recipientType, g.personId, date, lineUserId, primary),
      rows: g.rows,
    }));
  });
}

/** The sends whose key has not already been written today. Same rule as `dueReminders`, one level finer. */
export function dueSends(sends: ReminderSend[], alreadyKeyed: ReadonlySet<string>): ReminderSend[] {
  return sends.filter((s) => !alreadyKeyed.has(s.key));
}

/**
 * Who still needs today's reminder — the groups whose key is **not** already in `alreadyKeyed`.
 *
 * Pure, so the property the DoD is written in ("a 07:00 trigger then the 08:15 run: every due person gets
 * exactly one reminder") is a test rather than a live-box hope.
 */
export function dueReminders(
  groups: ReminderGroup[],
  date: string,
  alreadyKeyed: ReadonlySet<string>,
): ReminderGroup[] {
  return groups.filter((g) => !alreadyKeyed.has(reminderKey(g.recipientType, g.personId, date)));
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
