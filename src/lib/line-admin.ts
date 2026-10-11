// LINE OA admin recipients + CRM point updates (C.2 / C.5).

import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { appSettings, students } from "../db/schema";
import { levelCaseSql } from "./crm";
import { enqueueLine } from "./line";

const ADMIN_KEY = "line_admin_user_ids";

/**
 * 🔴 TASK-725 — the LEGACY admin links: bare LINE ids in `app_settings.line_admin_user_ids`, put there by whoever typed the (now retired) shared admin code.
 * READ-ONLY from now on: nothing adds to this list any more (`addAdminLineUserId` is DELETED, so that is structural, not a promise), it only shrinks —
 * `removeAdminLineUserId`, from the old panel — until each person re-links through the web or the super admin removes them.
 */
export async function getLegacyAdminLineUserIds(exec: any = db): Promise<string[]> {
  const row = await exec.query.appSettings.findFirst({
    where: (s: any, { eq: e }: any) => e(s.key, ADMIN_KEY),
  });
  const val = row?.value;
  return Array.isArray(val) ? (val as string[]).filter(Boolean) : [];
}

/**
 * TASK-725 — the LINKED admins: the LINE account of every web user who linked one and is NOT disabled (`disabled_at IS NULL`).
 * ⇒ Disabling a user turns that person's notices OFF, enabling turns them back ON, with no second switch to forget.
 */
export async function getLinkedAdminLineUserIds(exec: any = db): Promise<string[]> {
  const rows: Array<{ lineUserId: string | null }> = await exec.query.users.findMany({
    columns: { lineUserId: true },
    where: (u: any, { and, isNotNull, isNull }: any) => and(isNotNull(u.lineUserId), isNull(u.disabledAt)),
  });
  return rows.map((r) => r.lineUserId).filter((x): x is string => !!x);
}

/**
 * THE recipients, for every reader (`notifyAdmins`, `detectLinkedRole`, the menu sweep, the old panel): active linked users ∪ the legacy list,
 * DE-DUPLICATED (an account in both counts once), legacy first so the order readers have always seen is unchanged.
 */
export async function getAdminLineUserIds(exec: any = db): Promise<string[]> {
  const [legacy, linked] = await Promise.all([getLegacyAdminLineUserIds(exec), getLinkedAdminLineUserIds(exec)]);
  return [...new Set([...legacy, ...linked])];
}

/** 🔴 TASK-538 — take ONE id off the LEGACY list. 🔑 TASK-725: it reads the LEGACY list only — rebuilding it from `getAdminLineUserIds` would copy every linked user's id into it. */
export async function removeAdminLineUserId(lineUserId: string, exec: any = db): Promise<void> {
  const next = (await getLegacyAdminLineUserIds(exec)).filter((x) => x !== lineUserId);
  await exec
    .insert(appSettings)
    .values({ key: ADMIN_KEY, value: next })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: next, updatedAt: sql`now()` },
    });
}

/** Enqueue LINE to every linked admin (C.5). `bookingId` (TASK-136) links the outbox row to its booking so the
 *  worker can enrich the message with date/teacher/program — without it those fields render empty. */
export async function notifyAdmins(payload: unknown, exec: any = db, bookingId?: string): Promise<void> {
  const ids = await getAdminLineUserIds(exec);
  // TASK-152 (REQ-049 AC-4, found live on sid): with NO admin configured this loop simply never ran, so a leave
  // produced **zero** outbox rows — no send, and no trace that a send was even due. That is the silent drop the
  // AC exists to prevent; the teacher path has always written a visible SKIPPED row when there is no link, and
  // the admin path now does the same. One row, so a mis-configured environment is loud instead of empty.
  if (!ids.length) {
    await enqueueLine(
      { recipientType: "admin", recipientLineUserId: null, bookingId, payload, skipReason: "no admin recipient configured" },
      exec,
    );
    return;
  }
  for (const userId of ids) {
    await enqueueLine(
      { recipientType: "admin", recipientLineUserId: userId, bookingId, payload },
      exec,
    );
  }
}

export async function awardCrmPoints(
  studentId: string,
  delta: number,
  exec: any = db,
): Promise<{ points: number; level: number } | null> {
  if (delta === 0) return null;
  // 🔴 TASK-498 — ONE statement: the points move by `sql` (floored, TASK-496's shape) and the level is the ladder applied to
  // THAT SAME new total. Postgres evaluates both SETs against the one old row it has locked, so two awards at once can no
  // longer lose points (the old read-then-write did), and the level can never disagree with its points (computing it from a
  // value read earlier would have made that reachable). The answer comes from the write, never from a read.
  const total = sql`GREATEST(${students.crmPoints} + ${delta}, 0)`;
  const [row] = await exec
    .update(students)
    .set({ crmPoints: total, crmLevel: levelCaseSql(total) })
    .where(eq(students.id, studentId))
    .returning({ points: students.crmPoints, level: students.crmLevel });
  return row ? { points: row.points, level: row.level } : null;
}
