// Persist check-in tokens on bookings (C.1) — no scheduler.service import.

import { eq } from "drizzle-orm";
import { db } from "../db";
import { bookings } from "../db/schema";
import { checkinWindowMessage, generateCheckinToken, lateWindowEnd } from "./checkin";
import { hhmm } from "./time";
import { studentNamesOf } from "../db/mappers";

/** The token lives to the END of the check-in window (TASK-474: class end + late, same day), second 59. Late 0 ⇒ as before. */
export function tokenExpiryIso(date: string, endTime: string, lateMinutes = 0): Date {
  const end = lateWindowEnd(endTime, lateMinutes);
  const h = Math.floor(end / 60), m = end % 60;
  return new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:59+07:00`);
}

/** The public check-in URL for a path — ONE helper for the session's `/checkin` and the camp's `/checkin/camp` (TASK-403). */
export function checkinUrl(path: string): string {
  const base = process.env.PUBLIC_CHECKIN_BASE_URL ?? "";
  return base ? `${base.replace(/\/$/, "")}${path}` : path;
}

export async function issueCheckinToken(bookingId: string, exec: any = db, lateMinutes = 0) {
  const row = await exec.query.bookings.findFirst({
    where: (b: any, { eq: e }: any) => e(b.id, bookingId),
  });
  if (!row) return null;
  const token = generateCheckinToken();
  const expiresAt = tokenExpiryIso(row.date, row.endTime, lateMinutes);
  await exec
    .update(bookings)
    .set({ checkinToken: token, checkinTokenExpiresAt: expiresAt })
    .where(eq(bookings.id, bookingId));
  return { token, expiresAt: expiresAt.toISOString() };
}

export function formatCheckinPayload(row: {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  checkinToken?: string | null;
  checkinTokenExpiresAt?: Date | null;
  student?: { name?: string; nickname?: string | null } | null;
  coStudent?: { name?: string; nickname?: string | null } | null;
}, token: string, expiresAt: string, earlyMinutes?: number, lateMinutes = 0) {
  return {
    bookingId: row.id,
    token,
    url: checkinUrl(`/checkin?token=${token}`),
    expiresAt,
    // SPEC-029: keep the displayed window in step with the resolved early-minutes setting (falls back to the coded
    // default when the caller doesn't resolve it).
    window: checkinWindowMessage(row.date, hhmm(row.startTime), hhmm(row.endTime), earlyMinutes, lateMinutes), // TASK-474
    studentName: studentNamesOf(row) ?? "", // TASK-425 — the ONE name rule's student part
  };
}
