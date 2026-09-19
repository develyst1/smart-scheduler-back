// TASK-401 (REQ-095 Stage 3a, SPEC-082) — Balance camp: weeks · packages (the sale) · days (the ONE writer) · marks.
// The rules are pure in `lib/camp.ts`; this file is the reads, the transactions and the one revenue post — the
// VOUCHER's sale shape (validate the discount against the LINE total BEFORE any write → the rows in one tx →
// `recordSale` after the tx on an idempotency key). 🚫 No expiry, no per-day revenue, no slot block, no LINE.
import { and, asc, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { campDays, campPackages, campWeeks } from "../db/schema";
import { ApiException, badRequest, conflict, notFound } from "../lib/http";
import { bangkokNow } from "../lib/bangkok-time";
import { recordSale } from "../lib/sale-post";
import { CAMP_CARD, campItemRef, listPriceMinor } from "../lib/sale-items";
import { validateSaleDiscount } from "../lib/discount-plan";
import { assertDayTransition, campScanOutcome, campTokenExpiry, creditOf, datesOfWeek, isUndo, MAX_WEEK_DAYS, packageUnits, saleQuantity, unitsDelta, unitsPerDay, usedAfter, type CampHalf, type CampKind, type CampPlan, type CampDayStatus } from "../lib/camp";
import { generateCheckinToken } from "../lib/checkin";
import { checkinUrl } from "../lib/checkin-token";
import { type CampDayInput, type CampWeekInput } from "../lib/camp-reminder";
import { familyLineUserIdsBulk } from "../lib/family-link";
import { assertStudentActive } from "./parent.service";
import { assertHouseholdNotSuspended } from "./scheduler.service";

const CONSUMING_OR_PLANNED = ["PLANNED", "ATTENDED", "ABSENT"] as const;

// ───────────── weeks ─────────────
const toWeekDTO = (w: any, dayCounts: Record<string, number> = {}) => ({
  id: w.id, name: w.name, startDate: w.startDate, endDate: w.endDate, capacity: w.capacity ?? null, teacherIds: w.teacherIds ?? [],
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

export async function createWeek(input: { name: string; startDate: string; endDate: string; capacity?: number | null; teacherIds?: string[] }, actor: string | null) {
  const dates = datesOfWeek(input.startDate, input.endDate);
  if (dates.length < 1 || dates.length > MAX_WEEK_DAYS || dates.at(-1) !== input.endDate) throw badRequest(`สัปดาห์แคมป์ต้องมี 1–${MAX_WEEK_DAYS} วันติดกัน`);
  const [w] = await db.insert(campWeeks).values({ name: input.name, startDate: input.startDate, endDate: input.endDate, capacity: input.capacity ?? null, teacherIds: input.teacherIds ?? null, openedBy: actor }).returning();
  return { week: toWeekDTO(w) };
}

export async function updateWeek(id: string, input: { name?: string; capacity?: number | null; teacherIds?: string[]; status?: string }) {
  const w = await db.query.campWeeks.findFirst({ where: (x, { eq: e }) => e(x.id, id) });
  if (!w) throw notFound("ไม่พบสัปดาห์แคมป์");
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.capacity !== undefined) patch.capacity = input.capacity;
  if (input.teacherIds !== undefined) patch.teacherIds = input.teacherIds;
  if (input.status !== undefined) { patch.status = input.status; patch.closedAt = input.status === "CLOSED" ? new Date() : null; }
  const [updated] = await db.update(campWeeks).set(patch).where(eq(campWeeks.id, id)).returning();
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
  const days = datesOfWeek(w.startDate, w.endDate).map((date) => {
    const entries = (byDate.get(date) ?? []).map((r: any) => ({ dayId: r.id, packageId: r.campPackageId, studentId: r.package.studentId, studentName: r.package.student?.nickname ?? r.package.student?.name ?? null, kind: r.package.kind, half: r.half, units: r.units, status: r.status, undoReason: r.undoReason ?? null }));
    return { date, entries, count: entries.filter((e: any) => e.status !== "CANCELLED").length, capacity: w.capacity ?? null };
  });
  return { week: toWeekDTO(w), days };
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
  if (outcome === "already") return { already: true, day: dayDTO(d) };
  const { package: pkg } = await markDay(d.id, "ATTENDED", "checkin-qr");
  return { already: false, day: pkg.days.find((x) => x.dayId === d.id) ?? dayDTO({ ...d, status: "ATTENDED" }) };
}
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

/** The calendar's DAY BANNER: open/closed weeks overlapping the range with their per-date counts — no hour cells. */
export async function weeksForCalendar(range: { start: string; end: string }) {
  const { weeks } = await listWeeks({ from: range.start, to: range.end });
  return weeks.map((w) => ({ id: w.id, name: w.name, startDate: w.startDate, endDate: w.endDate, status: w.status, dayCounts: w.dayCounts }));
}
