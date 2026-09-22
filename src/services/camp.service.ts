// TASK-401 (REQ-095 Stage 3a, SPEC-082) — Balance camp: weeks · packages (the sale) · days (the ONE writer) · marks.
// The rules are pure in `lib/camp.ts`; this file is the reads, the transactions and the one revenue post — the
// VOUCHER's sale shape (validate the discount against the LINE total BEFORE any write → the rows in one tx →
// `recordSale` after the tx on an idempotency key). 🚫 No expiry, no per-day revenue, no slot block, no LINE.
import { and, asc, count, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, campDays, campPackages, campWeekDayRates, campWeekDays, campWeeks } from "../db/schema";
import { unitsToDays } from "../lib/camp-deduction";
import { householdLineUserIds } from "../lib/family-link";
import { enqueueLine } from "../lib/line";
import { ApiException, badRequest, conflict, notFound } from "../lib/http";
import { bangkokNow } from "../lib/bangkok-time";
import { recordSale } from "../lib/sale-post";
import { CAMP_CARD, campItemRef, listPriceMinor } from "../lib/sale-items";
import { validateSaleDiscount } from "../lib/discount-plan";
import { CAMP_WINDOW_DEFAULT, assertCampWindow, campSlotDiff, wantedCampSlots, assertDayTransition, campScanOutcome, campTokenExpiry, creditOf, datesOfWeek, isUndo, MAX_WEEK_DAYS, packageUnits, saleQuantity, unitsDelta, unitsPerDay, usedAfter, type CampHalf, type CampKind, type CampPlan, type CampDayStatus } from "../lib/camp";
import { generateCheckinToken } from "../lib/checkin";
import { checkinUrl } from "../lib/checkin-token";
import { type CampDayInput, type CampWeekInput } from "../lib/camp-reminder";
import { familyLineUserIdsBulk } from "../lib/family-link";
import { assertStudentActive } from "./parent.service";
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
      const [d] = await tx.insert(campWeekDays).values({ campWeekId: row!.id, date, teacherIds: input.teacherIds ?? [], startTime: ws, endTime: we }).returning();
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
        await tx.update(campWeekDays).set({ ...(input.teacherIds !== undefined ? { teacherIds: input.teacherIds } : {}), startTime: ws, endTime: we }).where(eq(campWeekDays.id, d.id));
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
  const dayRows = await db.query.campWeekDays.findMany({ where: (d, { eq: e }) => e(d.campWeekId, id), with: { rates: true } }); // TASK-418; TASK-443: + the day's rates
  const dayByDate = new Map(dayRows.map((d) => [d.date, d]));
  const days = datesOfWeek(w.startDate, w.endDate).map((date) => {
    const entries = (byDate.get(date) ?? []).map((r: any) => ({ dayId: r.id, packageId: r.campPackageId, studentId: r.package.studentId, studentName: r.package.student?.nickname ?? r.package.student?.name ?? null, kind: r.package.kind, half: r.half, units: r.units, status: r.status, undoReason: r.undoReason ?? null }));
    const d = dayByDate.get(date);
    return { date, entries, count: entries.filter((e: any) => e.status !== "CANCELLED").length, capacity: w.capacity ?? null, ...toDayDTO(d) };
  });
  return { week: toWeekDTO(w), days };
}

// ───────────── TASK-418 (REQ-095 §11, SPEC-085 A) — the camp BLOCK on the grid ─────────────
const toDayDTO = (d: any) => ({ campWeekDayId: d?.id ?? null, teacherIds: d?.teacherIds ?? [], startTime: hm(d?.startTime), endTime: hm(d?.endTime), editedAt: d?.editedAt ? new Date(d.editedAt).toISOString() : null, teacherRates: dayRatesOf(d) });

// ───────────── TASK-443 (REQ-104 §2 item 4) — the per-coach-per-day rate (behind key 59) ─────────────
/** `{ teacherId: minor }` for every coach ON the day — 0 when no rate row exists (the new-day default is the absence of a row). */
const dayRatesOf = (d: any): Record<string, number> => {
  const out: Record<string, number> = {};
  const set = new Map<string, number>((d?.rates ?? []).map((r: any) => [r.teacherId, r.rateMinor]));
  for (const t of d?.teacherIds ?? []) out[t] = set.get(t) ?? 0;
  return out;
};
export const RATE_TEACHER_NOT_ON_DAY = () => badRequest("ตั้งค่าเรทได้เฉพาะครูที่อยู่ในวันนี้");
/** Upsert the day's rates (a coach not on the day ⇒ 400). The caller's tx; the sync copies them onto the rows after. */
async function upsertDayRates(tx: any, dayId: string, coaches: string[], rates: Record<string, number>) {
  for (const [teacherId, rateMinor] of Object.entries(rates)) {
    if (!coaches.includes(teacherId)) throw RATE_TEACHER_NOT_ON_DAY();
    await tx.insert(campWeekDayRates).values({ campWeekDayId: dayId, teacherId, rateMinor }).onConflictDoUpdate({ target: [campWeekDayRates.campWeekDayId, campWeekDayRates.teacherId], set: { rateMinor } });
  }
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
  const wanted = d.week.status === "OPEN" ? wantedCampSlots(d.teacherIds ?? [], hm(d.startTime)!, hm(d.endTime)!) : new Set<string>();
  const existing = await existingCampRows(tx, dayId);
  const { insert, remove } = campSlotDiff(wanted, existing);
  // 🔴 TASK-445 — THE 500: the clash's `23505` ABORTS the transaction; the catch below then read the coach's name ON THAT TX
  // (`tx.query.teachers.findFirst`) ⇒ Postgres `25P02` ("current transaction is aborted"), a raw pg error, not an ApiException
  // ⇒ 500. The names are read HERE, before any insert can fail, so the catch touches nothing but memory.
  const teacherIds = [...new Set([...wanted].map((k) => k.split("|")[0]!))];
  const coachName = new Map<string, string>(teacherIds.length ? (await tx.query.teachers.findMany({ where: (x: any, { inArray: inA }: any) => inA(x.id, teacherIds) })).map((t: any) => [t.id, t.nickname ?? t.name ?? t.id]) : []);
  // TASK-443 — each coach's DAY rate rides the derived rows' `teacher_rate_minor` (a camp row has ONE teacher, no extras): the
  // inserted rows carry it, and the KEPT rows are re-stamped (the diff never touches a kept row, a rate change must reach it).
  const rates = dayRatesOf({ ...d, rates: await tx.query.campWeekDayRates.findMany({ where: (r: any, { eq: e }: any) => e(r.campWeekDayId, dayId) }) });
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
  for (const teacherId of d.teacherIds ?? []) {
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
export async function updateWeekDay(weekId: string, date: string, input: { teacherIds?: string[]; startTime?: string; endTime?: string; teacherRates?: Record<string, number> }) {
  const w = await db.query.campWeeks.findFirst({ where: (x, { eq: e }) => e(x.id, weekId) });
  if (!w) throw notFound("ไม่พบสัปดาห์แคมป์");
  if (w.status !== "OPEN") throw conflict("CAMP_WEEK_CLOSED", `สัปดาห์ ${w.name} ปิดรับแล้ว`);
  const d = await db.query.campWeekDays.findFirst({ where: (x, { and: a, eq: e }) => a(e(x.campWeekId, weekId), e(x.date, date)) });
  if (!d) throw notFound("ไม่พบวันแคมป์");
  const start = input.startTime ?? hm(d.startTime)!, end = input.endTime ?? hm(d.endTime)!;
  assertCampWindow(start, end);
  const result = await db.transaction(async (tx) => {
    await tx.update(campWeekDays).set({ teacherIds: input.teacherIds ?? d.teacherIds, startTime: start, endTime: end, editedAt: new Date() }).where(eq(campWeekDays.id, d.id));
    if (input.teacherRates) await upsertDayRates(tx, d.id, input.teacherIds ?? d.teacherIds, input.teacherRates); // TASK-443 — before the sync, which copies them
    return syncCampDayRows(tx, d.id);
  });
  const fresh = await db.query.campWeekDays.findFirst({ where: (x, { eq: e }) => e(x.id, d.id), with: { rates: true } });
  return { day: { date, ...toDayDTO(fresh) }, ...result };
}

// ───────────── packages (the sale) ─────────────
const toPackageDTO = (p: any, days: any[]) => {
  const planned = days.filter((d) => d.status === "PLANNED").reduce((s, d) => s + d.units, 0);
  return {
    id: p.id, studentId: p.studentId, kind: p.kind, plan: p.plan, totalUnits: p.totalUnits, usedUnits: p.usedUnits, plannedUnits: planned, credit: creditOf(p, planned),
    saleId: p.saleId ?? null, note: p.note ?? null,
    discount: p.discountKind ? { kind: p.discountKind, value: p.discountValue, reason: p.discountReason, actor: p.discountActor } : null,
    days: days.map((d) => ({ dayId: d.id, weekId: d.campWeekId, weekName: d.week?.name ?? null, date: d.date, half: d.half, units: d.units, status: d.status, undoReason: d.undoReason ?? null })),
    createdBy: p.createdBy ?? null, createdAt: new Date(p.createdAt).toISOString(),
  };
};

async function packageDTO(id: string, exec: any = db) {
  const p = await exec.query.campPackages.findFirst({ where: (x: any, { eq: e }: any) => e(x.id, id) });
  if (!p) throw notFound("ไม่พบแพ็กเกจแคมป์");
  const days = await exec.query.campDays.findMany({ where: (d: any, { eq: e }: any) => e(d.campPackageId, id), with: { week: true }, orderBy: (d: any, { asc: a }: any) => [a(d.date)] });
  return toPackageDTO(p, days);
}

export async function listPackages(studentId: string) {
  const rows = await db.query.campPackages.findMany({ where: (p, { eq: e }) => e(p.studentId, studentId), orderBy: (p, { desc }) => [desc(p.createdAt)] });
  const ids = rows.map((p) => p.id);
  const days = ids.length ? await db.query.campDays.findMany({ where: (d, { inArray: inA }) => inA(d.campPackageId, ids), with: { week: true }, orderBy: (d, { asc: a }) => [a(d.date)] }) : [];
  return { packages: rows.map((p) => toPackageDTO(p, days.filter((d) => d.campPackageId === p.id))) };
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
export async function markDay(dayId: string, status: CampDayStatus, actor: string | null, reason?: string | null) {
  const { date: today } = bangkokNow();
  const packageId = await db.transaction(async (tx) => {
    const d = await tx.query.campDays.findFirst({ where: (x: any, { eq: e }: any) => e(x.id, dayId) });
    if (!d) throw notFound("ไม่พบวันแคมป์");
    assertDayTransition(d.status, status, d.date, today);
    const undo = isUndo(d.status, status);
    if (undo && !reason) throw badRequest("การยกเลิกการบันทึกต้องระบุเหตุผล");
    const delta = unitsDelta(d.status, status, d.units);
    await tx.update(campDays).set({ status, markedBy: actor, markedAt: new Date(), undoReason: undo ? reason : null }).where(eq(campDays.id, dayId));
    if (delta !== 0) {
      const p = await tx.query.campPackages.findFirst({ where: (x: any, { eq: e }: any) => e(x.id, d.campPackageId) });
      await tx.update(campPackages).set({ usedUnits: usedAfter(p?.usedUnits ?? 0, delta) }).where(eq(campPackages.id, d.campPackageId));
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
export async function checkinCampByToken(token: string) {
  const d = await db.query.campDays.findFirst({ where: (x: any, { eq: e }: any) => e(x.checkinToken, token) });
  if (!d) throw notFound("โทเคนเช็คอินไม่ถูกต้อง");
  const { date: today } = bangkokNow();
  const outcome = campScanOutcome(d, today, new Date());
  if (outcome === "already") return { already: true, day: dayDTO(d), credit: creditDTO(await packageDTO(d.campPackageId)) };
  const { package: pkg } = await markDay(d.id, "ATTENDED", "checkin-qr");
  // TASK-443 (REQ-104 §2 item 5a) — the scan page shows what is left to consume: total − used, in DAYS (a future PLANNED day
  // is still the family's credit). No mask: the scan is the family's own, by token.
  return { already: false, day: pkg.days.find((x) => x.dayId === d.id) ?? dayDTO({ ...d, status: "ATTENDED" }), credit: creditDTO(pkg) };
}
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
    await tx.update(campDays).set({ status: "ATTENDED", markedBy: "end-of-day", markedAt: new Date() }).where(eq(campDays.id, d.id));
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
