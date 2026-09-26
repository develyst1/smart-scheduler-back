// TASK-401 (REQ-095 Stage 3a, SPEC-082) — Balance camp: weeks · packages (the sale) · days (the ONE writer) · marks.
// The rules are pure in `lib/camp.ts`; this file is the reads, the transactions and the one revenue post — the
// VOUCHER's sale shape (validate the discount against the LINE total BEFORE any write → the rows in one tx →
// `recordSale` after the tx on an idempotency key). 🚫 No expiry, no per-day revenue, no slot block, no LINE.
import { and, asc, count, eq, gte, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, campDays, campPackages, campWeekDayTeachers, campWeekDays, campWeeks } from "../db/schema";
import { unitsToDays } from "../lib/camp-deduction";
import { householdLineUserIds } from "../lib/family-link";
import { enqueueLine } from "../lib/line";
import { ApiException, badRequest, conflict, notFound } from "../lib/http";
import { bangkokNow } from "../lib/bangkok-time";
import { recordSale } from "../lib/sale-post";
import { CAMP_CARD, campItemRef, listPriceMinor } from "../lib/sale-items";
import { validateSaleDiscount } from "../lib/discount-plan";
import { CAMP_WINDOW_DEFAULT, assertCampWindow, campSlotDiff, wantedCampSlots, assertDayTransition, campScanOutcome, campTokenExpiry, creditOf, datesOfWeek, isUndo, MAX_WEEK_DAYS, packageUnits, saleQuantity, unitsDelta, unitsPerDay, type CampHalf, type CampKind, type CampPlan, type CampDayStatus } from "../lib/camp";
import { generateCheckinToken } from "../lib/checkin";
import { checkinUrl } from "../lib/checkin-token";
import { type CampDayInput, type CampWeekInput } from "../lib/camp-reminder";
import { familyLineUserIdsBulk } from "../lib/family-link";
import { anyHouseholdSuspended, assertStudentActive } from "./parent.service";
import { legacySourceOf, type Provenance, type ProvenanceView } from "../lib/checkin-channel";
import { tb } from "../lib/line-i18n";
import { assertHouseholdNotSuspended, insertBooking } from "./scheduler.service";
import { CAMP_KIND } from "../lib/other-kind";

const CONSUMING_OR_PLANNED = ["PLANNED", "ATTENDED", "ABSENT"] as const;

// ───────────── weeks ─────────────
const hm = (t: string | null | undefined) => (t ? String(t).slice(0, 5) : null);
const toWeekDTO = (w: any, dayCounts: Record<string, number> = {}) => ({
  id: w.id, name: w.name, startDate: w.startDate, endDate: w.endDate, capacity: w.capacity ?? null, teacherIds: w.teacherIds ?? [],
  windowStart: hm(w.windowStart) ?? CAMP_WINDOW_DEFAULT.start, windowEnd: hm(w.windowEnd) ?? CAMP_WINDOW_DEFAULT.end, // TASK-418 — the effective window
  status: w.status, openedBy: w.openedBy ?? null, openedAt: new Date(w.openedAt).toISOString(), closedAt: w.closedAt ? new Date(w.closedAt).toISOString() : null,
  dates: datesOfWeek(w.startDate, w.endDate), dayCounts,
});

/** Per-date head counts (PLANNED + ATTENDED + ABSENT — a day that holds a place) for several weeks, ONE grouped read. */
async function dayCountsByWeek(weekIds: string[], exec: any = db): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  if (!weekIds.length) return out;
  const rows = await exec.select({ weekId: campDays.campWeekId, date: campDays.date, n: count() }).from(campDays)
    .where(and(inArray(campDays.campWeekId, weekIds), inArray(campDays.status, [...CONSUMING_OR_PLANNED]))).groupBy(campDays.campWeekId, campDays.date);
  for (const r of rows) { const m = out.get(r.weekId) ?? {}; m[r.date] = Number(r.n); out.set(r.weekId, m); }
  return out;
}

export async function listWeeks(range: { from: string; to: string }) {
  const rows = await db.select().from(campWeeks).where(and(lte(campWeeks.startDate, range.to), gte(campWeeks.endDate, range.from))).orderBy(asc(campWeeks.startDate));
  const counts = await dayCountsByWeek(rows.map((w) => w.id));
  return { weeks: rows.map((w) => toWeekDTO(w, counts.get(w.id) ?? {})) };
}

export async function createWeek(input: { name: string; startDate: string; endDate: string; capacity?: number | null; teacherIds?: string[]; windowStart?: string; windowEnd?: string }, actor: string | null) {
  const dates = datesOfWeek(input.startDate, input.endDate);
  if (dates.length < 1 || dates.length > MAX_WEEK_DAYS || dates.at(-1) !== input.endDate) throw badRequest(`สัปดาห์แคมป์ต้องมี 1–${MAX_WEEK_DAYS} วันติดกัน`);
  const ws = input.windowStart ?? CAMP_WINDOW_DEFAULT.start, we = input.windowEnd ?? CAMP_WINDOW_DEFAULT.end;
  assertCampWindow(ws, we);
  // TASK-418 — ONE tx: the week, one day row per date (the week's teachers + window), and the derived CAMP rows through
  // the ONE sync. The first slot clash names the date, hour and teacher and NOTHING is written (the series shape).
  const w = await db.transaction(async (tx) => {
    const [row] = await tx.insert(campWeeks).values({ name: input.name, startDate: input.startDate, endDate: input.endDate, capacity: input.capacity ?? null, teacherIds: input.teacherIds ?? null, windowStart: input.windowStart ?? null, windowEnd: input.windowEnd ?? null, openedBy: actor }).returning();
    for (const date of dates) {
      const [d] = await tx.insert(campWeekDays).values({ campWeekId: row!.id, date, startTime: ws, endTime: we }).returning();
      // TASK-454 — the WEEK's roster seeds each day's coaches, every one on the day's own window (NULL = that default).
      await setDayTeachers(tx, d!.id, (input.teacherIds ?? []).map((teacherId) => ({ teacherId })));
      await syncCampDayRows(tx, d!.id);
    }
    return row!;
  });
  return { week: toWeekDTO(w) };
}

export async function updateWeek(id: string, input: { name?: string; capacity?: number | null; teacherIds?: string[]; status?: string; windowStart?: string; windowEnd?: string }) {
  const w = await db.query.campWeeks.findFirst({ where: (x, { eq: e }) => e(x.id, id) });
  if (!w) throw notFound("ไม่พบสัปดาห์แคมป์");
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.capacity !== undefined) patch.capacity = input.capacity;
  if (input.teacherIds !== undefined) patch.teacherIds = input.teacherIds;
  if (input.status !== undefined) { patch.status = input.status; patch.closedAt = input.status === "CLOSED" ? new Date() : null; }
  const ws = input.windowStart ?? hm(w.windowStart) ?? CAMP_WINDOW_DEFAULT.start, we = input.windowEnd ?? hm(w.windowEnd) ?? CAMP_WINDOW_DEFAULT.end;
  if (input.windowStart !== undefined || input.windowEnd !== undefined) { assertCampWindow(ws, we); patch.windowStart = ws; patch.windowEnd = we; }
  // TASK-418 — the cascades, ONE tx: a week-level teacher/window change re-derives ONLY the days nobody edited by hand
  // (`edited_at IS NULL`); CLOSED ⇒ every derived row of the week gone; OPEN again ⇒ every day re-synced.
  const [updated] = await db.transaction(async (tx) => {
    const [u] = await tx.update(campWeeks).set(patch).where(eq(campWeeks.id, id)).returning();
    const status = input.status ?? w.status;
    if (status === "CLOSED") {
      const days = await tx.query.campWeekDays.findMany({ where: (d: any, { eq: e }: any) => e(d.campWeekId, id) });
      for (const d of days) await deleteCampDayRows(tx, d.id);
    } else if (input.status === "OPEN" && w.status !== "OPEN") {
      const days = await tx.query.campWeekDays.findMany({ where: (d: any, { eq: e }: any) => e(d.campWeekId, id) });
      for (const d of days) await syncCampDayRows(tx, d.id);
    } else if (input.teacherIds !== undefined || input.windowStart !== undefined || input.windowEnd !== undefined) {
      const days = await tx.query.campWeekDays.findMany({ where: (d: any, { eq: e, isNull: nul, and: a }: any) => a(e(d.campWeekId, id), nul(d.editedAt)) });
      for (const d of days) {
        await tx.update(campWeekDays).set({ startTime: ws, endTime: we }).where(eq(campWeekDays.id, d.id));
        // TASK-454 — a week-level roster change replaces the day's coach set; a window change alone touches nobody's
        // own hours, because a coach on the default is stored as NULL and resolves to the new window by itself.
        if (input.teacherIds !== undefined) await setDayTeachers(tx, d.id, input.teacherIds.map((teacherId) => ({ teacherId })));
        await syncCampDayRows(tx, d.id);
      }
    }
    return [u];
  });
  const counts = await dayCountsByWeek([id]);
  return { week: toWeekDTO(updated, counts.get(id) ?? {}) };
}

/** The roster: per date, the children with kind / half / units / status, the count and the capacity. */
export async function weekDays(id: string) {
  const w = await db.query.campWeeks.findFirst({ where: (x, { eq: e }) => e(x.id, id) });
  if (!w) throw notFound("ไม่พบสัปดาห์แคมป์");
  const rows = await db.query.campDays.findMany({ where: (d, { eq: e }) => e(d.campWeekId, id), with: { package: { with: { student: true } } }, orderBy: (d, { asc: a }) => [a(d.date)] });
  const byDate = new Map<string, any[]>();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const dayRows = await db.query.campWeekDays.findMany({ where: (d, { eq: e }) => e(d.campWeekId, id), with: { teachers: true } }); // TASK-418; TASK-454: + the day's coaches (hours + rate)
  const dayByDate = new Map(dayRows.map((d) => [d.date, d]));
  const days = datesOfWeek(w.startDate, w.endDate).map((date) => {
    const entries = (byDate.get(date) ?? []).map((r: any) => ({ dayId: r.id, packageId: r.campPackageId, studentId: r.package.studentId, studentName: r.package.student?.nickname ?? r.package.student?.name ?? null, kind: r.package.kind, half: r.half, units: r.units, status: r.status, undoReason: r.undoReason ?? null }));
    const d = dayByDate.get(date);
    return { date, entries, count: entries.filter((e: any) => e.status !== "CANCELLED").length, capacity: w.capacity ?? null, ...toDayDTO(d) };
  });
  return { week: toWeekDTO(w), days };
}

// ───────────── TASK-418 (REQ-095 §11, SPEC-085 A) — the camp BLOCK on the grid ─────────────
const toDayDTO = (d: any) => {
  const teachers = campDayTeachers(d);
  return {
    campWeekDayId: d?.id ?? null,
    startTime: hm(d?.startTime),
    endTime: hm(d?.endTime),
    editedAt: d?.editedAt ? new Date(d.editedAt).toISOString() : null,
    // TASK-454 — each coach's OWN window (resolved: a NULL is the day's), with the rate that used to live in its own table.
    teachers,
    // 🔻 TASK-454, ONE deploy only: the two old shapes, DERIVED from `teachers` so nothing can disagree with it. They
    // retire in the BE task that follows @Fern's per-coach camp UI (the FE half of REQ-105 §1) — named in the report.
    teacherIds: teachers.map((t) => t.teacherId),
    teacherRates: Object.fromEntries(teachers.map((t) => [t.teacherId, t.rateMinor])),
  };
};

// ───────────── TASK-454 (REQ-105 §1) — who is on the day, with their own hours (TASK-443's rate rides along) ─────────────
/**
 * The day's coaches with their windows RESOLVED: a NULL start/end means the day's own window, so a day-level change
 * reaches every coach who never asked for their own hours. Sorted by start then id, so every reader sees one order.
 */
export const campDayTeachers = (d: any): Array<{ teacherId: string; startTime: string; endTime: string; rateMinor: number }> => {
  const ds = hm(d?.startTime) ?? CAMP_WINDOW_DEFAULT.start, de = hm(d?.endTime) ?? CAMP_WINDOW_DEFAULT.end;
  return [...(d?.teachers ?? [])]
    .map((t: any) => ({ teacherId: t.teacherId as string, startTime: hm(t.startTime) ?? ds, endTime: hm(t.endTime) ?? de, rateMinor: t.rateMinor ?? 0 }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.teacherId.localeCompare(b.teacherId));
};
export const RATE_TEACHER_NOT_ON_DAY = () => badRequest("ตั้งค่าเรทได้เฉพาะครูที่อยู่ในวันนี้");

/** One coach's row on a day, as the PATCH accepts it. Hours omitted ⇒ NULL ⇒ the day's window. */
export type CampDayTeacherInput = { teacherId: string; startTime?: string | null; endTime?: string | null; rateMinor?: number };

/**
 * Replace the day's coach set in ONE tx: upsert what was asked for, delete whoever is no longer on the day. Each
 * coach's window is validated the same way the day's is (`assertCampWindow`) — a coach may sit OUTSIDE the day's
 * default, deliberately: the default is a default, not a clamp.
 */
async function setDayTeachers(tx: any, dayId: string, teachers: CampDayTeacherInput[]) {
  for (const t of teachers) {
    if (t.startTime || t.endTime) {
      if (!t.startTime || !t.endTime) throw badRequest("ครูที่ตั้งเวลาเองต้องระบุทั้งเวลาเริ่มและเวลาจบ");
      assertCampWindow(t.startTime, t.endTime);
    }
    await tx
      .insert(campWeekDayTeachers)
      .values({ campWeekDayId: dayId, teacherId: t.teacherId, startTime: t.startTime ?? null, endTime: t.endTime ?? null, rateMinor: t.rateMinor ?? 0 })
      .onConflictDoUpdate({
        target: [campWeekDayTeachers.campWeekDayId, campWeekDayTeachers.teacherId],
        set: { startTime: t.startTime ?? null, endTime: t.endTime ?? null, ...(t.rateMinor === undefined ? {} : { rateMinor: t.rateMinor }) },
      });
  }
  const keep = teachers.map((t) => t.teacherId);
  await tx.delete(campWeekDayTeachers).where(keep.length ? and(eq(campWeekDayTeachers.campWeekDayId, dayId), notInArray(campWeekDayTeachers.teacherId, keep)) : eq(campWeekDayTeachers.campWeekDayId, dayId));
}

/** The PATCH's two accepted shapes as ONE list: `teachers` wins; the old `teacherIds`+`teacherRates` still parse. */
export function dayTeacherInputs(
  input: { teachers?: CampDayTeacherInput[]; teacherIds?: string[]; teacherRates?: Record<string, number> },
  current: Array<{ teacherId: string; startTime: string; endTime: string; rateMinor: number }>,
  dayWindow: { start: string; end: string },
): CampDayTeacherInput[] | null {
  if (input.teachers) return input.teachers;
  if (input.teacherIds === undefined && input.teacherRates === undefined) return null;
  const byId = new Map(current.map((t) => [t.teacherId, t]));
  const ids = input.teacherIds ?? current.map((t) => t.teacherId);
  // TASK-443's rule, kept: a rate may only be set for a coach who IS on the day (after this body's own `teacherIds`).
  for (const teacherId of Object.keys(input.teacherRates ?? {})) if (!ids.includes(teacherId)) throw RATE_TEACHER_NOT_ON_DAY();
  return ids.map((teacherId) => {
    const was = byId.get(teacherId);
    // A coach who had their OWN hours keeps them; one sitting on the day default stays NULL, so a later day-level
    // change still reaches them.
    const kept = was && (was.startTime !== dayWindow.start || was.endTime !== dayWindow.end) ? { startTime: was.startTime, endTime: was.endTime } : {};
    return { teacherId, ...kept, rateMinor: input.teacherRates?.[teacherId] ?? was?.rateMinor ?? 0 };
  });
}

/** The live derived rows of a day, keyed `teacherId|HH:MM` ⇒ id. */
async function existingCampRows(tx: any, dayId: string): Promise<Map<string, string>> {
  const rows = await tx.select({ id: bookings.id, teacherId: bookings.teacherId, startTime: bookings.startTime }).from(bookings).where(eq(bookings.campWeekDayId, dayId));
  return new Map(rows.map((r: any) => [`${r.teacherId}|${hm(r.startTime)}`, r.id]));
}

/**
 * THE ONE SYNC: the day row says who holds the block and when; this makes the rows agree. Wanted = teachers × the
 * window's hours; the diff against the existing CAMP rows inserts the missing (through `insertBooking` — the slot
 * index, the roster check; a clash ⇒ `409 SLOT_TAKEN` naming the date, hour and teacher, and the CALLER's tx rolls
 * back) and hard-DELETES the surplus (derived rows, no history, no money — the day row is the record). A CAMP row is
 * born CONFIRMED (a block has no confirm step — and the coach's reminder is CONFIRMED-only). ⇒ { inserted, deleted }.
 */
export async function syncCampDayRows(tx: any, dayId: string): Promise<{ inserted: number; deleted: number }> {
  const d = await tx.query.campWeekDays.findFirst({ where: (x: any, { eq: e }: any) => e(x.id, dayId), with: { week: true } });
  if (!d) throw notFound("ไม่พบวันแคมป์");
  // 🔴 TASK-445 (Tanya's 500) — a PAST date derives nothing and is left alone: a coach block in the past is history, not a
  // hold, and a week created mid-week must not clash on yesterday's sessions. (Nothing inserted, nothing deleted.)
  if (d.date < bangkokNow().date) return { inserted: 0, deleted: 0 };
  const coaches = campDayTeachers({ ...d, teachers: await tx.query.campWeekDayTeachers.findMany({ where: (t: any, { eq: e }: any) => e(t.campWeekDayId, dayId) }) });
  const wanted = d.week.status === "OPEN" ? wantedCampSlots(coaches.map((c) => ({ teacherId: c.teacherId, start: c.startTime, end: c.endTime }))) : new Set<string>();
  const existing = await existingCampRows(tx, dayId);
  const { insert, remove } = campSlotDiff(wanted, existing);
  // 🔴 TASK-445 — THE 500: the clash's `23505` ABORTS the transaction; the catch below then read the coach's name ON THAT TX
  // (`tx.query.teachers.findFirst`) ⇒ Postgres `25P02` ("current transaction is aborted"), a raw pg error, not an ApiException
  // ⇒ 500. The names are read HERE, before any insert can fail, so the catch touches nothing but memory.
  const teacherIds = [...new Set([...wanted].map((k) => k.split("|")[0]!))];
  const coachName = new Map<string, string>(teacherIds.length ? (await tx.query.teachers.findMany({ where: (x: any, { inArray: inA }: any) => inA(x.id, teacherIds) })).map((t: any) => [t.id, t.nickname ?? t.name ?? t.id]) : []);
  // TASK-443 — each coach's DAY rate rides the derived rows' `teacher_rate_minor` (a camp row has ONE teacher, no extras): the
  // inserted rows carry it, and the KEPT rows are re-stamped (the diff never touches a kept row, a rate change must reach it).
  const rates = Object.fromEntries(coaches.map((c) => [c.teacherId, c.rateMinor]));
  if (remove.length) await tx.delete(bookings).where(inArray(bookings.id, remove));
  for (const key of insert) {
    const [teacherId, hour] = key.split("|") as [string, string];
    try {
      const id = await insertBooking(tx, null, { teacherId, subjectId: null, date: d.date, startTime: hour, bookingType: "OTHER", otherTitle: d.week.name, otherKind: CAMP_KIND, status: "CONFIRMED", teacherRates: { [teacherId]: rates[teacherId] ?? 0 } });
      await tx.update(bookings).set({ campWeekDayId: dayId, confirmedAt: new Date() }).where(eq(bookings.id, id));
    } catch (e: any) {
      if (e instanceof ApiException && e.code === "SLOT_TAKEN") {
        throw conflict("SLOT_TAKEN", `วันที่ ${d.date} ${hour} ครู${coachName.get(teacherId) ?? teacherId} มีคาบแล้ว — ไม่ได้บันทึกอะไร`); // TASK-445: no tx read after the abort
      }
      throw e;
    }
  }
  for (const { teacherId } of coaches) {
    await tx.update(bookings).set({ teacherRateMinor: rates[teacherId] ?? 0 }).where(and(eq(bookings.campWeekDayId, dayId), eq(bookings.teacherId, teacherId))); // TASK-443 — the kept rows
  }
  return { inserted: insert.length, deleted: remove.length };
}

/** A closed week (or a day with no teacher) holds nothing: every derived row of the day gone. */
async function deleteCampDayRows(tx: any, dayId: string): Promise<number> {
  const rows = await tx.delete(bookings).where(eq(bookings.campWeekDayId, dayId)).returning({ id: bookings.id });
  return rows.length;
}

/**
 * The per-day edit = the per-day SWAP (`PATCH /camp/weeks/:id/days/:date`): the day row changes, `edited_at` is
 * stamped (a week-level change will leave this day alone), and the ONE sync re-derives it. A CLOSED week ⇒ 409.
 */
export async function updateWeekDay(weekId: string, date: string, input: { teachers?: CampDayTeacherInput[]; teacherIds?: string[]; startTime?: string; endTime?: string; teacherRates?: Record<string, number> }) {
  const w = await db.query.campWeeks.findFirst({ where: (x, { eq: e }) => e(x.id, weekId) });
  if (!w) throw notFound("ไม่พบสัปดาห์แคมป์");
  if (w.status !== "OPEN") throw conflict("CAMP_WEEK_CLOSED", `สัปดาห์ ${w.name} ปิดรับแล้ว`);
  const d = await db.query.campWeekDays.findFirst({ where: (x, { and: a, eq: e }) => a(e(x.campWeekId, weekId), e(x.date, date)), with: { teachers: true } });
  if (!d) throw notFound("ไม่พบวันแคมป์");
  const start = input.startTime ?? hm(d.startTime)!, end = input.endTime ?? hm(d.endTime)!;
  assertCampWindow(start, end);
  const result = await db.transaction(async (tx) => {
    await tx.update(campWeekDays).set({ startTime: start, endTime: end, editedAt: new Date() }).where(eq(campWeekDays.id, d.id));
    // TASK-454 — ONE body for who-is-on-the-day, their hours and their rate; the old `teacherIds`+`teacherRates` pair
    // still parses into the same list (one deploy). Before the sync, which copies the rates onto the derived rows.
    const teachers = dayTeacherInputs(input, campDayTeachers(d), { start, end });
    if (teachers) await setDayTeachers(tx, d.id, teachers);
    return syncCampDayRows(tx, d.id);
  });
  const fresh = await db.query.campWeekDays.findFirst({ where: (x, { eq: e }) => e(x.id, d.id), with: { teachers: true } });
  return { day: { date, ...toDayDTO(fresh) }, ...result };
}

// ───────────── packages (the sale) ─────────────
/** TASK-481 — `markedBy` (camp's provenance: `checkin-qr` · `shopfront-qr` · `end-of-day` · a staff username) is RAW for an
 *  unscoped read that asks (`provenance`), `null` otherwise — the same rule as a session's `checkinSource` (ruling B). */
/** TASK-488 — the three-state read for a camp day's mark: raw (admin) · null (scoped) · ABSENT (every other response). */
const campProvenance = (d: any, view: ProvenanceView | undefined) =>
  !view ? {} : view === "masked" ? { markedBy: null, markChannel: null, markActor: null } : { markedBy: d.markedBy ?? null, markChannel: d.markChannel ?? null, markActor: d.markActor ?? null };
const toPackageDTO = (p: any, days: any[], opts: { provenance?: ProvenanceView } = {}) => {
  const planned = days.filter((d) => d.status === "PLANNED").reduce((s, d) => s + d.units, 0);
  return {
    id: p.id, studentId: p.studentId, kind: p.kind, plan: p.plan, totalUnits: p.totalUnits, usedUnits: p.usedUnits, plannedUnits: planned, credit: creditOf(p, planned),
    saleId: p.saleId ?? null, note: p.note ?? null,
    discount: p.discountKind ? { kind: p.discountKind, value: p.discountValue, reason: p.discountReason, actor: p.discountActor } : null,
    days: days.map((d) => ({ dayId: d.id, weekId: d.campWeekId, weekName: d.week?.name ?? null, date: d.date, half: d.half, units: d.units, status: d.status, undoReason: d.undoReason ?? null, ...campProvenance(d, opts.provenance) })),
    createdBy: p.createdBy ?? null, createdAt: new Date(p.createdAt).toISOString(),
  };
};

async function packageDTO(id: string, exec: any = db) {
  const p = await exec.query.campPackages.findFirst({ where: (x: any, { eq: e }: any) => e(x.id, id) });
  if (!p) throw notFound("ไม่พบแพ็กเกจแคมป์");
  const days = await exec.query.campDays.findMany({ where: (d: any, { eq: e }: any) => e(d.campPackageId, id), with: { week: true }, orderBy: (d: any, { asc: a }: any) => [a(d.date)] });
  return toPackageDTO(p, days);
}

export async function listPackages(studentId: string, opts: { provenance?: ProvenanceView } = {}) { // TASK-481 — the route passes !scope
  const rows = await db.query.campPackages.findMany({ where: (p, { eq: e }) => e(p.studentId, studentId), orderBy: (p, { desc }) => [desc(p.createdAt)] });
  const ids = rows.map((p) => p.id);
  const days = ids.length ? await db.query.campDays.findMany({ where: (d, { inArray: inA }) => inA(d.campPackageId, ids), with: { week: true }, orderBy: (d, { asc: a }) => [a(d.date)] }) : [];
  return { packages: rows.map((p) => toPackageDTO(p, days.filter((d) => d.campPackageId === p.id), opts)) };
}

/**
 * The SALE — the voucher's shape: the discount validated against the LINE total (qty × list) BEFORE any write; the
 * package (+ its first week's PLANNED days through the ONE redeem writer) in one tx; `recordSale` ONCE after the tx.
 * Early bird = a typed discount with a reason (no product, no date rule). 🚫 Nothing else ever posts for a camp.
 */
export async function createPackage(
  input: { studentId: string; kind: CampKind; plan: CampPlan; days?: number; discount?: any; note?: string; firstWeek?: { weekId: string; dates: string[]; half: CampHalf }; actor?: string | null },
) {
  const totalUnits = packageUnits(input.kind, input.plan, input.days);
  const ref = campItemRef(input.kind, input.plan);
  const qty = saleQuantity(input.plan, input.days);
  const discount = validateSaleDiscount(input.discount, (listPriceMinor(ref) ?? CAMP_CARD[ref].priceMinor) * qty, input.actor ?? null);
  const result = await db.transaction(async (tx) => {
    await assertStudentActive(tx, input.studentId); // REQ-093 — an archived child buys nothing
    await assertHouseholdNotSuspended(tx, input.studentId); // TASK-058 — a suspended household buys nothing
    const [p] = await tx.insert(campPackages).values({
      studentId: input.studentId, kind: input.kind, plan: input.plan, totalUnits, note: input.note ?? null, createdBy: input.actor ?? null,
      ...(discount ? { discountKind: input.discount.kind, discountValue: input.discount.value, discountReason: discount.reason, discountActor: discount.actor } : {}),
    }).returning();
    let planned = 0;
    if (input.firstWeek) planned = await planDays(tx, p!.id, input.firstWeek, input.actor ?? null);
    return { id: p!.id, planned };
  });
  void recordSale(ref, qty, { refId: result.id, idempotencyKey: `camp-sale:${result.id}`, discount: discount ?? undefined }).catch((e) =>
    console.error(`[camp] sale NOT POSTED — package ${result.id} ${ref} × ${qty}: ${e?.message ?? e}`),
  );
  return { package: await packageDTO(result.id), planned: result.planned };
}

// ───────────── days — the ONE writer ─────────────
/**
 * Plan days on a package: the week OPEN, every date inside it, per date the CAPACITY (a place is PLANNED/ATTENDED/
 * ABSENT — CANCELLED frees it), the UNIQUE (one row per child per date), and the CREDIT running down the list
 * (units ≤ total − used − planned). All or nothing (the caller's tx). ⇒ the number planned.
 */
export async function planDays(tx: any, packageId: string, input: { weekId: string; dates: string[]; half: CampHalf }, actor: string | null): Promise<number> {
  const p = await tx.query.campPackages.findFirst({ where: (x: any, { eq: e }: any) => e(x.id, packageId) });
  if (!p) throw notFound("ไม่พบแพ็กเกจแคมป์");
  const w = await tx.query.campWeeks.findFirst({ where: (x: any, { eq: e }: any) => e(x.id, input.weekId) });
  if (!w) throw notFound("ไม่พบสัปดาห์แคมป์");
  if (w.status !== "OPEN") throw conflict("CAMP_WEEK_CLOSED", `สัปดาห์ ${w.name} ปิดรับแล้ว`);
  const weekDates = new Set(datesOfWeek(w.startDate, w.endDate));
  const dates = [...input.dates].sort();
  const units = unitsPerDay(input.half);
  const [plannedRow] = await tx.select({ n: sql<number>`coalesce(sum(${campDays.units}), 0)` }).from(campDays).where(and(eq(campDays.campPackageId, packageId), eq(campDays.status, "PLANNED")));
  let credit = creditOf(p, Number(plannedRow?.n ?? 0));
  for (const date of dates) {
    if (!weekDates.has(date)) throw badRequest(`วันที่ ${date} ไม่อยู่ในสัปดาห์ ${w.name}`);
    if (w.capacity != null) {
      const [c] = await tx.select({ n: count() }).from(campDays).where(and(eq(campDays.campWeekId, w.id), eq(campDays.date, date), inArray(campDays.status, [...CONSUMING_OR_PLANNED])));
      const taken = Number(c?.n ?? 0);
      if (taken >= w.capacity) throw conflict("CAMP_FULL", `วันที่ ${date} เต็ม (${taken}/${w.capacity})`);
    }
    if (units > credit) throw conflict("CAMP_NO_CREDIT", `วันที่ ${date} เครดิตไม่พอ (เหลือ ${credit} หน่วย)`);
    try {
      await tx.insert(campDays).values({ campPackageId: packageId, campWeekId: w.id, date, half: input.half, units });
    } catch (e: any) {
      if (String(e?.code ?? e?.cause?.code) === "23505") throw conflict("CAMP_DAY_TAKEN", `วันที่ ${date} มีวันแคมป์อยู่แล้ว`);
      throw e;
    }
    credit -= units;
  }
  void actor;
  return dates.length;
}

export async function redeemDays(packageId: string, input: { weekId: string; dates: string[]; half: CampHalf }, actor: string | null) {
  const planned = await db.transaction(async (tx) => {
    const p = await tx.query.campPackages.findFirst({ where: (x: any, { eq: e }: any) => e(x.id, packageId) });
    if (!p) throw notFound("ไม่พบแพ็กเกจแคมป์");
    await assertStudentActive(tx, p.studentId);
    await assertHouseholdNotSuspended(tx, p.studentId);
    return planDays(tx, packageId, input, actor);
  });
  return { planned, package: await packageDTO(packageId) };
}

/**
 * Mark a day: the transitions + the units delta on the package, in one tx. TASK-403: `status: "PLANNED"` is the UNDO
 * (ATTENDED | ABSENT → PLANNED): the units go BACK (`used` floored at 0), the reason is stored on the row, no money
 * moves (there is no sale here — by absence). A mark clears a previous undo's reason. The day-end cut's rows
 * (`marked_by = "end-of-day"`) and a staff mark undo alike — only `status` is read.
 */
export async function markDay(dayId: string, status: CampDayStatus, by: Provenance, reason?: string | null) { // TASK-488 — channel + actor
  const { date: today } = bangkokNow();
  const packageId = await db.transaction(async (tx) => {
    const d = await tx.query.campDays.findFirst({ where: (x: any, { eq: e }: any) => e(x.id, dayId) });
    if (!d) throw notFound("ไม่พบวันแคมป์");
    assertDayTransition(d.status, status, d.date, today);
    const undo = isUndo(d.status, status);
    if (undo && !reason) throw badRequest("การยกเลิกการบันทึกต้องระบุเหตุผล");
    const delta = unitsDelta(d.status, status, d.units);
    await tx.update(campDays).set({ status, markedBy: legacySourceOf(by), markChannel: by.channel, markActor: by.actor ?? null, markedAt: new Date(), undoReason: undo ? reason : null }).where(eq(campDays.id, dayId));
    if (delta !== 0) {
      // TASK-496 — `sql` arithmetic, floored: the value is never read into JS and written back (two marks at once lost a count).
      await tx.update(campPackages).set({ usedUnits: sql`GREATEST(${campPackages.usedUnits} + ${delta}, 0)` }).where(eq(campPackages.id, d.campPackageId));
    }
    return d.campPackageId;
  });
  return { package: await packageDTO(packageId) };
}

// ───────────── the check-in QR (TASK-403) ─────────────
/**
 * The staff's QR for ONE camp day — the token is minted LAZILY here on the first view (a day may be planned weeks
 * ahead; a token minted at redeem would sit live for weeks), and lives to 23:59:59 of the day's date. The QR image
 * is the FE's, as the session's.
 */
export async function getDayCheckinQr(dayId: string) {
  const d = await db.query.campDays.findFirst({ where: (x: any, { eq: e }: any) => e(x.id, dayId), with: { package: { with: { student: true } } } });
  if (!d) throw notFound("ไม่พบวันแคมป์");
  let token = d.checkinToken, expiresAt = d.checkinTokenExpiresAt;
  if (!token) {
    token = generateCheckinToken();
    expiresAt = campTokenExpiry(d.date);
    await db.update(campDays).set({ checkinToken: token, checkinTokenExpiresAt: expiresAt }).where(eq(campDays.id, dayId));
  }
  return { dayId: d.id, token, url: checkinUrl(`/checkin/camp?token=${token}`), expiresAt: expiresAt!.toISOString(), studentName: (d as any).package?.student?.nickname ?? (d as any).package?.student?.name ?? "", date: d.date, half: d.half };
}

/**
 * The public scan (`POST /checkin/camp { token }`, no JWT — the token is the credential). The outcome is the pure
 * rule (`campScanOutcome`); an attend goes through the SAME `markDay` transition (consumes the units). 🚫 No CRM
 * points — a camp day has no "on time" (Sober 09-19: on the owner's list, not built).
 */
export async function checkinCampByToken(token: string, source: "checkin-qr" | "shopfront-qr" = "checkin-qr") { // TASK-475 — `marked_by` says where from
  const d = await db.query.campDays.findFirst({ where: (x: any, { eq: e }: any) => e(x.checkinToken, token), with: { package: true } });
  if (!d) throw notFound(tb("checkin_bad_link")); // TASK-479 — the parent's words, not "token"
  // 🔴 TASK-476 — camp's token page had the SAME gap: a suspended household is refused, FIRST, as the LINE path refuses it.
  if (await anyHouseholdSuspended((d as any).package?.studentId ? [(d as any).package.studentId] : [])) throw badRequest(tb("suspended_notice"));
  const { date: today } = bangkokNow();
  const outcome = campScanOutcome(d, today, new Date());
  if (outcome === "already") return scanAnswer(true, d, await packageDTO(d.campPackageId));
  const { package: pkg } = await markDay(d.id, "ATTENDED", { channel: source });
  // TASK-443 (REQ-104 §2 item 5a) — the scan page shows what is left to consume: total − used, in DAYS (a future PLANNED day
  // is still the family's credit). No mask: the scan is the family's own, by token.
  return scanAnswer(false, d, pkg);
}
/**
 * 🔴 TASK-502 — the public scan's ONE answer, for BOTH paths. The day comes from the ADMIN package DTO, so it is copied
 * through an allow-list LITERAL — never a spread: a spread (or a spread with deletions) re-admits every field the admin DTO
 * gains later, and the two it can gain are a per-coach day RATE (REQ-104) and the marker's identity (`provenance`). The 8
 * keys are the family's own: `undoReason` is shown on purpose (the "undone" line). `studentName` is NOT here — a product
 * question, ruled separately. Both paths answer the same shape, so the already-scanned reply carries `weekName` too.
 */
const scanAnswer = (already: boolean, d: any, pkg: Awaited<ReturnType<typeof packageDTO>>) => {
  const x: any = pkg.days.find((y) => y.dayId === d.id) ?? { ...dayDTO(already ? d : { ...d, status: "ATTENDED" }), weekName: null };
  return {
    already,
    day: { dayId: x.dayId, weekId: x.weekId, weekName: x.weekName ?? null, date: x.date, half: x.half, units: x.units, status: x.status, undoReason: x.undoReason ?? null },
    credit: creditDTO(pkg),
  };
};
const creditDTO = (p: { totalUnits: number; usedUnits: number }) => ({ remainingDays: unitsToDays(p.totalUnits - p.usedUnits), totalDays: unitsToDays(p.totalUnits) });
const dayDTO = (d: any) => ({ dayId: d.id, weekId: d.campWeekId, date: d.date, half: d.half, units: d.units, status: d.status, undoReason: d.undoReason ?? null });

// ───────────── the reminder's inputs (TASK-403) ─────────────
/**
 * The camp rows for the 08:15 job — a SEPARATE select on `camp_days` (the session reminder's select is REQ-094's
 * byte-frozen one). Every PLANNED day dated `runDate` with its student's family accounts, and every OPEN week
 * covering `runDate` with its teachers. The builder (`lib/camp-reminder.ts`) decides who gets what.
 */
export async function campReminderInputs(runDate: string): Promise<{ days: CampDayInput[]; weeks: CampWeekInput[] }> {
  const weeksRows = await db.query.campWeeks.findMany({ where: (w: any, { and: a, lte: le, gte: ge, eq: e }: any) => a(le(w.startDate, runDate), ge(w.endDate, runDate), e(w.status, "OPEN")) });
  const teacherIds = [...new Set(weeksRows.flatMap((w: any) => w.teacherIds ?? []))] as string[];
  const teacherRows = teacherIds.length ? await db.query.teachers.findMany({ where: (t: any, { inArray: inA }: any) => inA(t.id, teacherIds) }) : [];
  const teacherById = new Map(teacherRows.map((t: any) => [t.id, t]));
  const weeks: CampWeekInput[] = weeksRows.map((w: any) => ({ id: w.id, name: w.name, status: w.status, teachers: (w.teacherIds ?? []).map((id: string) => ({ id, lineUserId: teacherById.get(id)?.lineUserId ?? null })) }));
  const dayRows = await db.query.campDays.findMany({ where: (d: any, { eq: e }: any) => e(d.date, runDate), with: { package: { with: { student: true } } } });
  const parentIds = [...new Set(dayRows.map((d: any) => d.package?.student?.parentId).filter(Boolean))] as string[];
  const familyAccounts = await familyLineUserIdsBulk(parentIds);
  const days: CampDayInput[] = dayRows.map((d: any) => ({
    dayId: d.id, weekId: d.campWeekId, half: d.half, status: d.status, studentId: d.package?.studentId,
    studentName: d.package?.student?.nickname ?? d.package?.student?.name ?? "-",
    parentId: d.package?.student?.parentId ?? null,
    parentLineUserIds: d.package?.student?.parentId ? (familyAccounts.get(d.package.student.parentId) ?? []) : [],
  }));
  return { days, weeks };
}

/**
 * The DAY CUT (called INSIDE the end-of-day transaction): every PLANNED camp day whose date has STARTED
 * (`date <= runDate` — a day has no start time; today counts, the start-based ruling of TASK-396) ⇒ ATTENDED and its
 * units consumed. ⇒ the count, for `job_runs`.
 */
export async function cutCampDays(tx: any, runDate: string): Promise<number> {
  const due = await tx.select({ id: campDays.id, packageId: campDays.campPackageId, units: campDays.units }).from(campDays).where(and(eq(campDays.status, "PLANNED"), lte(campDays.date, runDate)));
  for (const d of due) {
    await tx.update(campDays).set({ status: "ATTENDED", markedBy: "end-of-day", markChannel: "end-of-day", markActor: null, markedAt: new Date() }).where(eq(campDays.id, d.id));
    await tx.update(campPackages).set({ usedUnits: sql`${campPackages.usedUnits} + ${d.units}` }).where(eq(campPackages.id, d.packageId));
  }
  return due.length;
}

/**
 * TASK-443 (REQ-104 §2 item 5b) — the DAY-END `camp_deduction` family notice, the second pass after the cut (INSIDE the
 * end-of-day transaction): every CONSUMING camp day (ATTENDED | ABSENT — `consumes()`: a no-show is charged, §8) dated on or
 * before the run date and NOT yet stamped ⇒ ONE row per family account (`householdLineUserIds`, the ONE read; no account ⇒ one
 * skipped row, the Private deduction's shape), then `deduction_notified_at` stamped — the stamp is the idempotency (a re-run
 * enqueues nothing; no outbox key rides a tx). The owner's ruling: at day-end, not at scan — a day scanned at 09:00 is ATTENDED
 * long before the cut, which is why this is a pass over the stamp and not a hook on the cut's rows. The payload carries
 * everything (a camp day has no booking row): the remaining credit read AFTER the cut consumed today's units. ⇒ the count.
 */
export async function notifyCampDeductions(tx: any, runDate: string): Promise<number> {
  const due = await tx.query.campDays.findMany({
    where: (d: any, { and: a, inArray: inA, lte: le, isNull: nul }: any) => a(inA(d.status, ["ATTENDED", "ABSENT"]), le(d.date, runDate), nul(d.deductionNotifiedAt)),
    with: { package: { with: { student: true } } },
  });
  for (const d of due) {
    const p = d.package;
    const payload = {
      kind: "camp_deduction",
      studentName: p?.student?.nickname ?? p?.student?.name ?? "",
      date: d.date,
      remainingDays: unitsToDays((p?.totalUnits ?? 0) - (p?.usedUnits ?? 0)),
      totalDays: unitsToDays(p?.totalUnits ?? 0),
    };
    const accounts = p?.studentId ? await householdLineUserIds(tx, [p.studentId]) : [];
    if (!accounts.length) await enqueueLine({ recipientType: "parent", recipientLineUserId: null, payload }, tx);
    for (const lineUserId of accounts) await enqueueLine({ recipientType: "parent", recipientLineUserId: lineUserId, payload }, tx);
    await tx.update(campDays).set({ deductionNotifiedAt: new Date() }).where(eq(campDays.id, d.id));
  }
  return due.length;
}

/** The calendar's DAY BANNER: open/closed weeks overlapping the range with their per-date counts — no hour cells. */
export async function weeksForCalendar(range: { start: string; end: string }) {
  const { weeks } = await listWeeks({ from: range.start, to: range.end });
  return weeks.map((w) => ({ id: w.id, name: w.name, startDate: w.startDate, endDate: w.endDate, status: w.status, dayCounts: w.dayCounts }));
}
