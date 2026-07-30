// Per-teacher `.ics` subscription feed (REQ-017 / TASK-044). Read-only; the token in the URL is the credential.
// Isolation rule: a teacher id is NEVER accepted from the URL/query — the token resolves to exactly one teacher
// and the booking query filters by that id (same rule as the TASK-038 pickers).

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { teachers } from "../db/schema";
import { notFound } from "../lib/http";
import { addDays } from "../lib/time";
import { bangkokNow } from "../lib/bangkok-time";

/** Bounded window keeps the feed small and fast (the teacher-date index covers it). */
export const CALENDAR_WINDOW_BACK_DAYS = 30;
export const CALENDAR_WINDOW_FORWARD_DAYS = 90;

/** 192-bit URL-safe bearer secret (≥128 bits as specified). */
const generateCalendarToken = () => randomBytes(24).toString("base64url");

/**
 * Get-or-create the teacher's feed token. `rotate` issues a new one, which makes the previous link 404
 * immediately (the old token no longer resolves to any teacher).
 */
export async function getOrCreateCalendarToken(teacherId: string, opts: { rotate?: boolean } = {}) {
  const teacher = await db.query.teachers.findFirst({ where: (t, { eq: e }) => e(t.id, teacherId) });
  if (!teacher) throw notFound("ไม่พบครู");
  if (teacher.calendarToken && !opts.rotate) return { token: teacher.calendarToken, rotated: false };
  const token = generateCalendarToken();
  await db.update(teachers).set({ calendarToken: token }).where(eq(teachers.id, teacherId));
  return { token, rotated: !!teacher.calendarToken };
}

/** The token of an already-linked teacher (for the LINE "my calendar" reply), created on first ask. */
export async function getCalendarTokenForLineUser(lineUserId: string): Promise<string | null> {
  const teacher = await db.query.teachers.findFirst({
    where: (t, { eq: e }) => e(t.lineUserId, lineUserId),
  });
  if (!teacher) return null;
  const { token } = await getOrCreateCalendarToken(teacher.id);
  return token;
}

/**
 * Token → that teacher's bookings inside the feed window. Returns null for an unknown/rotated token so the
 * route can 404 without distinguishing "expired" from "never existed".
 *
 * CANCELLED bookings are **included** on purpose — they're serialized with `STATUS:CANCELLED` so subscribers
 * remove them; dropping them would leave a cancelled class sitting on the teacher's phone.
 */
export async function findBookingsForCalendarToken(token: string) {
  const teacher = await db.query.teachers.findFirst({
    where: (t, { eq: e }) => e(t.calendarToken, token),
  });
  if (!teacher) return null;
  const { date } = bangkokNow();
  const from = addDays(date, -CALENDAR_WINDOW_BACK_DAYS);
  const to = addDays(date, CALENDAR_WINDOW_FORWARD_DAYS);
  const rows = await db.query.bookings.findMany({
    where: (b, { and, eq: e, gte, lte }) =>
      and(e(b.teacherId, teacher.id), gte(b.date, from), lte(b.date, to)),
    with: { student: true, subject: true },
    orderBy: (b, { asc }) => [asc(b.date), asc(b.startTime)],
  });
  return { teacher, rows };
}
