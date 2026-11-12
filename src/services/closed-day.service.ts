// TASK-959 (REQ-5013 option B, SPEC-105 §3) — list / close / reopen a CLOSED DAY. It writes ONLY `closed_days`: it cancels nothing, moves nothing, restores nothing and sends NO message (SPEC-105 §4.6).
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { closedDays } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";
import { closedReasonTh, isClosedReason, liveClassesOnDates, MAX_CLOSED_RANGE_DAYS, openClosedRows, type ClosedDayClass, type ClosedReason } from "../lib/closed-day";
import { ApiException } from "../lib/http";
import { addDays } from "../lib/time";

export interface ClosedDayRow {
  date: string;
  reason: ClosedReason;
  note: string | null;
  rangeId: string | null;
  createdBy: string;
  createdAt: string;
  bookings: ClosedDayClass[];
}

/** SPEC-105 §3 — `GET /closed-days?from&to`: only OPEN rows, ordered by date, each with the live classes still on its date. `from` defaults to today and `to` to 60 days on (the door's validation caps the span at 62). */
export async function listClosedDays(q: { from?: string; to?: string }): Promise<{ items: ClosedDayRow[] }> {
  const from = q.from ?? bangkokNow().date;
  const to = q.to ?? addDays(from, 60);
  const rows = await openClosedRows(db, from, to);
  const classes = await liveClassesOnDates(db, rows.map((r: any) => r.date as string));
  return {
    items: rows.map((r: any) => ({
      date: r.date as string,
      reason: r.reason as ClosedReason,
      note: (r.note ?? null) as string | null,
      rangeId: (r.rangeId ?? null) as string | null,
      createdBy: r.createdBy as string,
      createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
      bookings: classes.filter((c) => c.date === r.date),
    })),
  };
}

const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

/**
 * SPEC-105 §3 — `POST /closed-days`. One row per day in ONE transaction, a shared `range_id` when there is more than one new day. A day ALREADY closed is skipped (not an error).
 * Refusals (each `400 { error: { code, message } }`): `PAST_DATE` (any day before today, Bangkok; TODAY is allowed), `NOTE_REQUIRED` (reason OTHER with an empty note), `RANGE_TOO_LONG` (> 31 days).
 * ⇒ `{ created, alreadyClosed, classesOnThem }`: `classesOnThem` = the live classes now sitting on the created days (the FE says "N classes are on these days; they are in Attention").
 */
export async function closeDays(input: { from: string; to?: string; reason: string; note?: string | null }, actor: string | null) {
  const from = input.from;
  const to = input.to ?? input.from;
  const today = bangkokNow().date;
  if (!isClosedReason(input.reason)) throw new ApiException(400, "VALIDATION", "เหตุผลไม่ถูกต้อง");
  if (from < today) throw new ApiException(400, "PAST_DATE", "ปิดวันทำการย้อนหลังไม่ได้ — เลือกวันนี้หรือวันถัดไป");
  const note = (input.note ?? "").trim();
  if (input.reason === "OTHER" && !note) throw new ApiException(400, "NOTE_REQUIRED", "กรุณาระบุหมายเหตุเมื่อเลือกเหตุผล «อื่นๆ»");
  if (days(from, to) > MAX_CLOSED_RANGE_DAYS) throw new ApiException(400, "RANGE_TOO_LONG", `ปิดวันทำการได้ครั้งละไม่เกิน ${MAX_CLOSED_RANGE_DAYS} วัน`);

  const wanted: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) wanted.push(d);

  return db.transaction(async (tx: any) => {
    const open: Array<{ date: string }> = await openClosedRows(tx, from, to);
    const already = new Set(open.map((r) => r.date));
    const fresh = wanted.filter((d) => !already.has(d));
    const created: string[] = [];
    if (fresh.length) {
      const rangeId = fresh.length > 1 ? randomUUID() : null;
      const inserted: Array<{ date: string }> = await tx
        .insert(closedDays)
        .values(fresh.map((date) => ({ date, reason: input.reason, note: note || null, rangeId, createdBy: actor ?? "unknown" })))
        .onConflictDoNothing() // a racing writer closed the same day first: the unique index decides, and that day reads as alreadyClosed
        .returning({ date: closedDays.date });
      for (const r of inserted) created.push(r.date);
    }
    const createdSet = new Set(created);
    const alreadyClosed = wanted.filter((d) => !createdSet.has(d));
    const classesOnThem = created.length ? (await liveClassesOnDates(tx, created)).length : 0;
    return { created: created.sort(), alreadyClosed, classesOnThem };
  });
}

/**
 * SPEC-105 §3 — `DELETE /closed-days/:date` (re-open). Sets `reopened_at` / `reopened_by` on the open row and keeps it. `404 NOT_CLOSED` when the day has no open row; `400 PAST_DATE` for a day before today
 * (a day that has begun stays as it was, mirroring the leave lift). It restores nothing and messages no one.
 */
export async function reopenDay(date: string, actor: string | null) {
  const today = bangkokNow().date;
  const open = await db.query.closedDays.findFirst({ where: (c, { and: a, eq: e, isNull: nil }) => a(e(c.date, date), nil(c.reopenedAt)) });
  if (!open) throw new ApiException(404, "NOT_CLOSED", "วันนี้ไม่ได้ปิดทำการอยู่");
  if (date < today) throw new ApiException(400, "PAST_DATE", "เปิดวันทำการย้อนหลังไม่ได้ — วันที่เริ่มไปแล้วคงสภาพเดิม");
  const done = await db
    .update(closedDays)
    .set({ reopenedAt: new Date(), reopenedBy: actor ?? "unknown" })
    .where(and(eq(closedDays.id, open.id), isNull(closedDays.reopenedAt)))
    .returning({ id: closedDays.id });
  if (!done.length) throw new ApiException(404, "NOT_CLOSED", "วันนี้ไม่ได้ปิดทำการอยู่"); // a racing re-open won
  return { date, reopened: true as const };
}

export { closedReasonTh };
