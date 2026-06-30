// Persist check-in tokens on bookings (C.1) — no scheduler.service import.

import { eq } from "drizzle-orm";
import { db } from "../db";
import { bookings } from "../db/schema";
import { checkinWindowMessage, generateCheckinToken } from "./checkin";
import { hhmm } from "./time";

function tokenExpiryIso(date: string, endTime: string): Date {
  const [h, m] = hhmm(endTime).split(":").map(Number);
  return new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:59+07:00`);
}

export async function issueCheckinToken(bookingId: string, exec: any = db) {
  const row = await exec.query.bookings.findFirst({
    where: (b: any, { eq: e }: any) => e(b.id, bookingId),
  });
  if (!row) return null;
  const token = generateCheckinToken();
  const expiresAt = tokenExpiryIso(row.date, row.endTime);
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
  student?: { name?: string };
}, token: string, expiresAt: string) {
  const base = process.env.PUBLIC_CHECKIN_BASE_URL ?? "";
  const path = `/checkin?token=${token}`;
  return {
    bookingId: row.id,
    token,
    url: base ? `${base.replace(/\/$/, "")}${path}` : path,
    expiresAt,
    window: checkinWindowMessage(row.date, hhmm(row.startTime), hhmm(row.endTime)),
    studentName: row.student?.name ?? "",
  };
}
