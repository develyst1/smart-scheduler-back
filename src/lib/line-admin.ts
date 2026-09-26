// LINE OA admin recipients + CRM point updates (C.2 / C.5).

import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { appSettings, students } from "../db/schema";
import { levelCaseSql } from "./crm";
import { enqueueLine } from "./line";

const ADMIN_KEY = "line_admin_user_ids";

export async function getAdminLineUserIds(exec: any = db): Promise<string[]> {
  const row = await exec.query.appSettings.findFirst({
    where: (s: any, { eq: e }: any) => e(s.key, ADMIN_KEY),
  });
  const val = row?.value;
  return Array.isArray(val) ? (val as string[]).filter(Boolean) : [];
}

export async function addAdminLineUserId(lineUserId: string, exec: any = db): Promise<void> {
  const existing = await getAdminLineUserIds(exec);
  if (existing.includes(lineUserId)) return;
  const next = [...existing, lineUserId];
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
