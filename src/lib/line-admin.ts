// LINE OA admin recipients + CRM point updates (C.2 / C.5).

import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { appSettings, students } from "../db/schema";
import { applyPoints } from "./crm";
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
  const row = await exec.query.students.findFirst({
    where: (s: any, { eq: e }: any) => e(s.id, studentId),
  });
  if (!row) return null;
  const { points, level } = applyPoints(row.crmPoints ?? 0, delta);
  await exec
    .update(students)
    .set({ crmPoints: points, crmLevel: level.level })
    .where(eq(students.id, studentId));
  return { points, level: level.level };
}
