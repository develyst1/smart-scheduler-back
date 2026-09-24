// TASK-428 (REQ-101, SPEC-088 Part A) — the OTHER SERIES Manage-plan: an ECA/Free/KOL schedule is N `OTHER` rows under ONE
// `other_series_key` (minted by `createOtherSeries`). This file is every read and write BY KEY: the rows, the range list,
// 🔻 TASK-441 (REQ-104 §2 item 3): the SAME functions serve a GROUP series by `group_key` — a `SeriesKey` names the column
// and the row type; a bare string key is the OTHER series (every OTHER caller byte-identical). A group adds: seats on the
// DTO's rows, the cancel-all CASCADE (every live seat through the per-row path — `cancelSeatsOfGroup` + the families), the
// confirm-all over the seated courses (`confirmCourse` each), add-dates as GROUP rows (no seats), and the primary swap
// DELEGATED to `swapGroupTeacher` (the OTHER swap never moves seats).
// confirm-all (the existing bulk-confirm loop), cancel-all (one tx; the coach told ONCE per teacher), add / remove / swap a
// teacher from a date on (one tx; the first clash names the date and rolls the whole call back), add dates (the template
// row's facts copied), and the header edit on every live row. No money; GROUP and CAMP objects untouched; Free/KOL by
// construction (the kind is a tag on the row).
import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { db } from "../db";
import { bookingTeachers, bookings } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";
import { COURSE_LIVE_STATUSES, isEndReason } from "../lib/course-plan";
import { ApiException, badRequest, conflict, notFound, pgErrorCode } from "../lib/http";
import { enqueueLine } from "../lib/line";
import { assertRatesOnBooking } from "../lib/other-kind";

import { hhmm } from "../lib/time";
import { displayNameOf } from "../db/mappers";
import {
  assertTeacherBookable,
  attachAdditionalTeachers,
  bulkConfirm,
  cancelSeatsOfGroup,
  classCancelledFamilyAccounts,
  confirmCourse,
  insertBooking,
  reconcileBookingHolds,
  swapGroupTeacher,
  GROUP_SERIES_CLOSED,
} from "./scheduler.service";

/** TASK-441 — which column names the series and which row type it holds. A bare string = the OTHER series (TASK-428's shape). */
export type SeriesKey = string | { otherSeriesKey: string } | { groupKey: string };
const keyOf = (k: SeriesKey): { field: "otherSeriesKey" | "groupKey"; value: string; type: "OTHER" | "GROUP" } =>
  typeof k === "string" ? { field: "otherSeriesKey", value: k, type: "OTHER" }
  : "groupKey" in k ? { field: "groupKey", value: k.groupKey, type: "GROUP" }
  : { field: "otherSeriesKey", value: k.otherSeriesKey, type: "OTHER" };
const isGroupKey = (k: SeriesKey) => keyOf(k).type === "GROUP";

const LIVE = [...COURSE_LIVE_STATUSES];
export const PRIMARY_TEACHER = () => conflict("PRIMARY_TEACHER", "ครูคนแรกของตารางนำออกไม่ได้ — ใช้สลับครูแทน");
export const ALREADY_ON_ROW = (date: string) => conflict("ALREADY_ON_ROW", `วันที่ ${date} ครูคนนี้อยู่ในตารางแล้ว`);
const NOT_FOUND = () => notFound("ไม่พบตารางชุดนี้");

type SeriesRow = {
  id: string; date: string; startTime: string; endTime: string | null; status: string; teacherId: string;
  otherTitle: string | null; otherKind: string | null; headCount: number | null; note: string | null; teacherRateMinor: number | null;
  additionalTeachers: Array<{ teacherId: string; rateMinor: number | null; teacher?: { id: string; nickname: string | null; name: string; lineUserId?: string | null } | null }>;
  teacher?: { id: string; nickname: string | null; name: string; lineUserId?: string | null } | null;
  seats?: Array<{ id: string; studentId: string | null; status: string; courseId: string | null; student?: any; coStudent?: any; otherTitle?: string | null }>; // TASK-441 — a GROUP row's seats
};

/** Every row of the series, any status, date order — the ONE read the page and every door start from. */
async function seriesRows(exec: any, key: SeriesKey): Promise<SeriesRow[]> {
  const k = keyOf(key);
  return exec.query.bookings.findMany({
    where: (b: any, { and: a, eq: e }: any) => a(e(b[k.field], k.value), e(b.bookingType, k.type)),
    with: { teacher: true, additionalTeachers: { with: { teacher: true } }, ...(k.type === "GROUP" ? { seats: { with: { student: true, coStudent: true } } } : {}) }, // TASK-441 — a group's seats ride the read
    orderBy: (b: any, { asc }: any) => [asc(b.date), asc(b.startTime)],
  });
}

/** TASK-428 (the owner's ruling 2) — the LIVE rows from a date on: add / remove / swap never touch the past. */
export function seriesRowsFrom(rows: SeriesRow[], fromDate: string): SeriesRow[] {
  return rows.filter((r) => LIVE.includes(r.status as any) && r.date >= fromDate);
}

const today = () => bangkokNow().date;
const isLive = (r: SeriesRow) => LIVE.includes(r.status as any);
const templateOf = (rows: SeriesRow[]): SeriesRow | null => rows.find(isLive) ?? rows[0] ?? null;
const extrasOf = (r: SeriesRow) => (r.additionalTeachers ?? []).map((a) => a.teacherId);
const ratesOf = (r: SeriesRow): Record<string, number> => {
  const out: Record<string, number> = {};
  if (r.teacherRateMinor != null) out[r.teacherId] = r.teacherRateMinor;
  for (const a of r.additionalTeachers ?? []) if (a.rateMinor != null) out[a.teacherId] = a.rateMinor;
  return out;
};

export type SeriesDTO = {
  key: string; title: string | null; kind: string | null; headCount: number | null; startTime: string; teacherId: string;
  additionalTeacherIds: string[]; teacherRates: Record<string, number>;
  rows: Array<{ bookingId: string; date: string; status: string; teacherId: string; additionalTeacherIds: string[]; seats?: Array<{ bookingId: string; studentId: string | null; displayName: string; status: string }> }>;
};

/** `GET /other-series/:key` — the header facts from the first LIVE row (else the first), every row in date order. */
export async function getOtherSeries(key: SeriesKey): Promise<SeriesDTO> {
  const rows = await seriesRows(db, key);
  const t = templateOf(rows);
  if (!t) throw NOT_FOUND();
  const group = isGroupKey(key);
  return {
    key: keyOf(key).value, title: t.otherTitle, kind: t.otherKind, headCount: t.headCount, startTime: hhmm(t.startTime), teacherId: t.teacherId,
    additionalTeacherIds: extrasOf(t), teacherRates: ratesOf(t),
    rows: rows.map((r) => ({
      bookingId: r.id, date: r.date, status: r.status, teacherId: r.teacherId, additionalTeacherIds: extrasOf(r),
      // TASK-441 — every seat, any status (the modal greys a cancelled one); the ONE name rule for the child
      ...(group ? { seats: (r.seats ?? []).map((x) => ({ bookingId: x.id, studentId: x.studentId, displayName: displayNameOf(x), status: x.status })) } : {}),
    })),
  };
}

/** `GET /other-series?from&to` — one line per series with ≥ 1 row in the range. */
export async function listOtherSeries(range: { from: string; to: string }, type: "OTHER" | "GROUP" = "OTHER") {
  const col = type === "GROUP" ? bookings.groupKey : bookings.otherSeriesKey; // TASK-441 — the group list, the same walk
  const keys = await db
    .select({ key: col })
    .from(bookings)
    .where(and(isNotNull(col), eq(bookings.bookingType, type), gte(bookings.date, range.from), lte(bookings.date, range.to)))
    .groupBy(col);
  const out = [];
  for (const { key } of keys) {
    if (!key) continue;
    const rows = await seriesRows(db, type === "GROUP" ? { groupKey: key } : key);
    const t = templateOf(rows);
    if (!t) continue;
    out.push({
      key, title: t.otherTitle, kind: t.otherKind, startTime: hhmm(t.startTime), teacherId: t.teacherId,
      firstDate: rows[0]!.date, lastDate: rows[rows.length - 1]!.date, liveCount: rows.filter(isLive).length, total: rows.length,
    });
  }
  return out.sort((a, b) => a.firstDate.localeCompare(b.firstDate) || (a.title ?? "").localeCompare(b.title ?? ""));
}

/** Confirm all — the existing bulk-confirm loop (per row atomic; a skipped row is reported, never hidden) over the key's PENDING rows. */
export async function confirmAllOtherSeries(key: SeriesKey) {
  const rows = await seriesRows(db, key);
  if (!rows.length) throw NOT_FOUND();
  const { results } = await bulkConfirm(rows.filter((r) => r.status === "PENDING").map((r) => r.id));
  const out = { confirmed: results.filter((r) => r.outcome === "confirmed").length, skipped: results.filter((r) => r.outcome !== "confirmed").length, results };
  if (!isGroupKey(key)) return out;
  // TASK-441 — confirm-whole-group: every seated course (the live seats on the live rows, by course) through `confirmCourse`
  // — its ONE `course_confirmed` per course, unchanged; a refused course (ended, budget) is reported as skipped, never hidden.
  const courseIds = [...new Set(rows.filter(isLive).flatMap((r) => (r.seats ?? []).filter((x) => LIVE.includes(x.status as any)).map((x) => x.courseId)).filter((id): id is string => !!id))];
  const courses: Array<{ courseId: string; outcome: "confirmed" | "skipped"; confirmed?: number; reason?: string }> = [];
  for (const courseId of courseIds) {
    try {
      const r = await confirmCourse(courseId);
      courses.push({ courseId, outcome: "confirmed", confirmed: r.confirmed });
    } catch (e) {
      if (!(e instanceof ApiException)) throw e;
      courses.push({ courseId, outcome: "skipped", reason: e.message });
    }
  }
  return { ...out, courses: courses.length, courseResults: courses };
}

/**
 * Cancel all — every LIVE row ⇒ CANCELLED with the reason code, ONE tx; ATTENDED rows are history and stay. The coach is
 * told ONCE per teacher (`other_series_cancelled`, the dates listed) — a cancel-all enqueues NO per-row notice.
 * 🔴 TASK-430 — the notice covers EVERY live row cancelled, PENDING included: ADDED already told the coach about pending
 * dates, so a cancel-all must tell them those dates are gone. The per-row cancel keeps its CONFIRMED-only rule.
 */
export async function cancelAllOtherSeries(key: SeriesKey, input: { reasonCode: string; note?: string }, actor: string | null) {
  if (!isEndReason(input.reasonCode)) throw badRequest("เหตุผลไม่ถูกต้อง");
  const group = isGroupKey(key);
  return db.transaction(async (tx) => {
    const rows = await seriesRows(tx, key);
    if (!rows.length) throw NOT_FOUND();
    const live = rows.filter(isLive);
    let seatsCancelled = 0, familyNotices = 0;
    const households = new Set<string>(); // TASK-445 — distinct LINE accounts across the whole cancel-all
    for (const r of live) {
      await tx.update(bookings).set({ status: "CANCELLED", cancelReason: input.reasonCode, note: input.note?.trim() || r.note }).where(eq(bookings.id, r.id));
      await reconcileBookingHolds(tx, r.id, r.teacherId, "CANCELLED", false);
      if (group) {
        // TASK-441 — the CASCADE, the per-row status cancel's own path (`:3453` + `:3471`): every live seat CANCELLED and its
        // course re-owed (`reconcileCoursePlan`), then each seat's household told `class_cancelled_parent` (a CONFIRMED row only —
        // the family rule). The seats send no teacher notice; the coach is told ONCE below with the group's name.
        seatsCancelled += await cancelSeatsOfGroup(tx, r.id, input.note?.trim() || null);
        const accounts = (await classCancelledFamilyAccounts(tx, { ...r, bookingType: "GROUP", seats: r.seats ?? undefined } as any, input.reasonCode)) ?? []; // TASK-445: siblings once per row
        familyNotices += accounts.length;
        for (const a of accounts) households.add(a);
      }
    }
    const t = templateOf(rows)!;
    await notifySeriesTeachers(tx, "other_series_cancelled", t, live, { reason: input.reasonCode, actor }); // TASK-430 — EVERY live row, PENDING included (the series notices are their own family)
    return group ? { cancelled: live.length, seatsCancelled, familyNotices, householdsTold: households.size } : { cancelled: live.length };
  });
}

/** Add a teacher (an EXTRA) to every live row from `fromDate` (default today) — one tx; the first clash rolls back. */
export async function addTeacherToOtherSeries(key: SeriesKey, input: { teacherId: string; rateMinor?: number; fromDate?: string; onDate?: string }) {
  return db.transaction(async (tx) => {
    const rows = await seriesRows(tx, key);
    if (!rows.length) throw NOT_FOUND();
    // 🔴 TASK-453 (REQ-105 §8.1 gaps) — `onDate` = ONE session, not "from here on". A cover coach for a single week
    // was N calls plus a removal from the following date; it is now one call. 📌 The SAME live filter either way —
    // `seriesRowsFrom` restated as "this date only", never a second idea of which rows may be touched.
    const targets = input.onDate ? rows.filter((r) => isLive(r) && r.date === input.onDate) : seriesRowsFrom(rows, input.fromDate ?? today());
    if (input.onDate && !targets.length) throw NOT_FOUND();
    for (const r of targets) {
      if (r.teacherId === input.teacherId || extrasOf(r).includes(input.teacherId)) throw ALREADY_ON_ROW(r.date);
      try {
        await attachAdditionalTeachers(tx, r.id, [input.teacherId], input.rateMinor != null ? { [input.teacherId]: input.rateMinor } : {});
      } catch (e) {
        if (e instanceof ApiException && e.code === "SLOT_TAKEN") throw conflict("SLOT_TAKEN", `วันที่ ${r.date} ${hhmm(r.startTime)} — ${e.message} — ไม่ได้บันทึกอะไร`);
        throw e;
      }
    }
    if (targets.length) await notifySeriesTeachers(tx, "other_teacher_added", templateOf(rows)!, targets, {}, [input.teacherId]);
    return { added: targets.length };
  });
}

/**
 * 🔴 TASK-453 (REQ-105 §8.1 gaps) — CLOSE the series: the intake ends, the class does not. Every row of the key is
 * stamped (so any row answers "is it closed?" — no template read to go stale), and from that moment `seatOnGroup`
 * refuses a new child and `addDatesToOtherSeries` refuses a new date. 🚫 Existing rows are UNTOUCHED — not
 * cancelled, not hidden: the kids already enrolled keep every date that was already there. Idempotent: closing a
 * closed series re-stamps nothing and reports `0`.
 */
export async function closeGroupSeries(key: { groupKey: string }) {
  return db.transaction(async (tx) => {
    const rows = await seriesRows(tx, key);
    if (!rows.length) throw NOT_FOUND();
    if (rows.some((r: any) => r.groupClosedAt)) return { closed: 0, alreadyClosed: true };
    const now = new Date();
    await tx.update(bookings).set({ groupClosedAt: now }).where(eq(bookings.groupKey, key.groupKey));
    return { closed: rows.length, alreadyClosed: false };
  });
}

/** Remove an EXTRA from every live row from `fromDate` (default today); the primary ⇒ 409 (swap instead). */
export async function removeTeacherFromOtherSeries(key: SeriesKey, teacherId: string, input: { fromDate?: string }) {
  return db.transaction(async (tx) => {
    const rows = await seriesRows(tx, key);
    if (!rows.length) throw NOT_FOUND();
    const targets = seriesRowsFrom(rows, input.fromDate ?? today());
    if (targets.some((r) => r.teacherId === teacherId)) throw PRIMARY_TEACHER();
    const hit = targets.filter((r) => extrasOf(r).includes(teacherId));
    if (hit.length) {
      await tx.delete(bookingTeachers).where(and(inArray(bookingTeachers.bookingId, hit.map((r) => r.id)), eq(bookingTeachers.teacherId, teacherId)));
      await notifySeriesTeachers(tx, "other_teacher_removed", templateOf(rows)!, hit, {}, [teacherId]);
    }
    return { removed: hit.length };
  });
}

/** Swap the PRIMARY from `fromDate` on (the group swap's shape by key): `from` must be the primary; `to` not on the row. */
export async function swapOtherSeriesTeacher(key: string, input: { from: string; to: string; fromDate?: string }) {
  if (isGroupKey(key)) throw badRequest("การสลับครูของกลุ่มใช้ swapGroupTeacher"); // TASK-441 — the OTHER swap never moves seats
  return db.transaction(async (tx) => {
    const rows = await seriesRows(tx, key);
    if (!rows.length) throw NOT_FOUND();
    const targets = seriesRowsFrom(rows, input.fromDate ?? today());
    let moved = 0;
    for (const r of targets) {
      if (r.teacherId !== input.from) throw badRequest(`วันที่ ${r.date} ครูคนแรกไม่ใช่คนที่ระบุ`);
      if (extrasOf(r).includes(input.to)) throw ALREADY_ON_ROW(r.date);
      await assertTeacherBookable(tx, input.to, r.date);
      try {
        await tx.update(bookings).set({ teacherId: input.to }).where(eq(bookings.id, r.id));
      } catch (e: any) {
        if (pgErrorCode(e) === "23505") throw conflict("SLOT_TAKEN", `วันที่ ${r.date} ${hhmm(r.startTime)} ครูไม่ว่าง — ไม่ได้ย้ายรายการใด`);
        throw e;
      }
      await reconcileBookingHolds(tx, r.id, input.to, r.status, false);
      // the existing per-row coach kinds (the course plan's shape): the old primary loses the row, the new one gains it
      const [oldT, newT] = await Promise.all([
        tx.query.teachers.findFirst({ where: (t: any, { eq: e }: any) => e(t.id, input.from) }),
        tx.query.teachers.findFirst({ where: (t: any, { eq: e }: any) => e(t.id, input.to) }),
      ]);
      await enqueueLine({ recipientType: "teacher", recipientLineUserId: oldT?.lineUserId ?? null, bookingId: r.id, payload: { kind: "teacher_unassigned", bookingId: r.id } }, tx);
      await enqueueLine({ recipientType: "teacher", recipientLineUserId: newT?.lineUserId ?? null, bookingId: r.id, payload: { kind: "teacher_assigned", bookingId: r.id } }, tx);
      moved++;
    }
    return { moved };
  });
}

/**
 * TASK-441 — the GROUP primary swap from a date on: DELEGATED to `swapGroupTeacher` (every live seat follows its group row —
 * the OTHER swap has no seats and would strand them). The first live row on/after `fromDate` (default today) is the anchor.
 */
export async function swapGroupSeriesTeacher(key: { groupKey: string }, input: { to: string; fromDate?: string }) {
  const rows = await seriesRows(db, key);
  if (!rows.length) throw NOT_FOUND();
  const anchor = seriesRowsFrom(rows, input.fromDate ?? today())[0];
  if (!anchor) return { moved: 0 };
  if (anchor.teacherId === input.to) throw ALREADY_ON_ROW(anchor.date);
  const r = await swapGroupTeacher(anchor.id, { teacherId: input.to, fromHereOn: true });
  return { moved: r.moved };
}

/** Add dates — more rows into the key; the template row's facts (title · kind · heads · start · primary · extras · rates) copied. */
export async function addDatesToOtherSeries(key: SeriesKey, input: { dates: string[] }) {
  const k = keyOf(key);
  return db.transaction(async (tx) => {
    const rows = await seriesRows(tx, key);
    const t = templateOf(rows);
    if (!t) throw NOT_FOUND();
    const have = new Set(rows.filter(isLive).map((r) => r.date));
    const extras = extrasOf(t), rates = ratesOf(t);
    const ids: string[] = [];
    for (const date of [...input.dates].sort()) {
      if (have.has(date)) throw conflict("DATE_EXISTS", `วันที่ ${date} มีในตารางชุดนี้แล้ว`);
      if ((t as any).groupClosedAt) throw GROUP_SERIES_CLOSED(); // TASK-453 — a closed series gains no date
      try {
        const id = await insertBooking(tx, null, {
          teacherId: t.teacherId, subjectId: null, date, startTime: hhmm(t.startTime), bookingType: k.type, otherTitle: t.otherTitle,
          otherKind: t.otherKind, headCount: t.headCount, note: t.note, teacherRates: rates, [k.field]: k.value, // TASK-441 — a GROUP date is a GROUP row under the key (no seats; `seatOnGroup` fills them)
        });
        if (extras.length) await attachAdditionalTeachers(tx, id, extras, rates);
        ids.push(id);
      } catch (e) {
        if (e instanceof ApiException && e.code === "SLOT_TAKEN") throw conflict("SLOT_TAKEN", `วันที่ ${date} ครูไม่ว่าง — ไม่ได้สร้างรายการใด (${e.message})`);
        throw e;
      }
    }
    return { created: ids.length, bookingIds: ids };
  });
}

/** The header edit — title / kind / heads / rates on every LIVE row (no `startTime`: a time change is N moves). */
export async function updateOtherSeries(key: SeriesKey, input: { title?: string; otherKind?: string; headCount?: number | null; teacherRates?: Record<string, number> }) {
  if (isGroupKey(key) && input.otherKind !== undefined) throw badRequest("ประเภทของกลุ่มเปลี่ยนไม่ได้"); // TASK-441 — a group's kind is fixed (DUO | GROUP ⇔ its courses)
  return db.transaction(async (tx) => {
    const rows = await seriesRows(tx, key);
    if (!rows.length) throw NOT_FOUND();
    const live = rows.filter(isLive);
    if (input.teacherRates) {
      const t = templateOf(rows)!;
      assertRatesOnBooking(input.teacherRates, [t.teacherId, ...extrasOf(t)]);
    }
    for (const r of live) {
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.otherTitle = input.title;
      if (input.otherKind !== undefined) patch.otherKind = input.otherKind;
      if (input.headCount !== undefined) patch.headCount = input.headCount;
      if (input.teacherRates && r.teacherId in input.teacherRates) patch.teacherRateMinor = input.teacherRates[r.teacherId];
      if (Object.keys(patch).length) await tx.update(bookings).set(patch).where(eq(bookings.id, r.id));
      if (input.teacherRates) {
        for (const teacherId of extrasOf(r)) {
          if (teacherId in input.teacherRates) {
            await tx.update(bookingTeachers).set({ rateMinor: input.teacherRates[teacherId] }).where(and(eq(bookingTeachers.bookingId, r.id), eq(bookingTeachers.teacherId, teacherId)));
          }
        }
      }
    }
    return { updated: live.length };
  });
}

/**
 * The series notices — ONE outbox row per teacher (never one per row): `other_teacher_added` / `other_teacher_removed` to the
 * named teachers, `other_series_cancelled` to every teacher on the affected rows. The payload carries everything the
 * renderer prints (title · kind · the hour · the dates) — a series notice is not a row's, so no `bookingId` rides.
 */
async function notifySeriesTeachers(
  tx: any,
  kind: "other_teacher_added" | "other_teacher_removed" | "other_series_cancelled",
  t: SeriesRow,
  rows: SeriesRow[],
  extra: Record<string, unknown>,
  onlyTeacherIds?: string[],
) {
  if (!rows.length) return;
  const teacherIds = onlyTeacherIds ?? [...new Set(rows.flatMap((r) => [r.teacherId, ...extrasOf(r)]))];
  const teachers = await tx.query.teachers.findMany({ where: (x: any, { inArray: inA }: any) => inA(x.id, teacherIds) });
  const payload = { kind, title: t.otherTitle, otherKind: t.otherKind, startTime: hhmm(t.startTime), endTime: t.endTime ? hhmm(t.endTime) : null, dates: rows.map((r) => r.date), ...extra };
  for (const teacherId of teacherIds) {
    const teacher = teachers.find((x: any) => x.id === teacherId);
    await enqueueLine({ recipientType: "teacher", recipientLineUserId: teacher?.lineUserId ?? null, payload }, tx);
  }
}
