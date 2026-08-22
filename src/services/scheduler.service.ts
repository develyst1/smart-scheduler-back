// Business logic — the source of truth for scheduling. Routes stay thin and call
// these; all domain rules (quota/extension/idempotency) live here.

import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { appSettings, bookings, boItem, boMovement, coursePackages, parents, students, subjects, teacherSubjects, teachers, vouchers } from "../db/schema";
import type { BulkConfirmResult, TeacherType } from "../types/contract";
import { preCheckBulkConfirm } from "../lib/bulk-confirm";
import { toBookingDTO, toCourseWithStudent, toTeacherDTO, toVoucherDTO } from "../db/mappers";
import { canTakeLeave, MAX_WEEK_BY_SIZE, toCourseSummary } from "../lib/leave";
import { SLOT_NON_BLOCKING } from "../lib/booking-slot";
import { firstFreeWeeklySlot } from "../lib/extension-slot";
import { afterReturn, returnsConsumedUnit } from "../lib/checkin-correction";
import {
  COURSE_SUBJECT_LOCKED,
  COURSE_SUBJECT_LOCKED_MESSAGE,
  changesCourseSubject,
} from "../lib/course-subject-lock";
import { hasEnoughLeaveNotice, leaveCutoffKey, leaveNoticeMessage } from "../lib/leave-notice";
import {
  hasEnoughTeacherChangeNotice,
  teacherChangeNoticeMessage,
} from "../lib/teacher-change-notice";
import { getSetting } from "./settings.service";
import {
  courseExpiry,
  courseSessionDates,
  isCourseSize,
  remainingSessions,
  weekdayOf,
} from "../lib/recurring";
import {
  formatWorkDaysLabel,
  removedWorkDays,
  sessionsOnRemovedDays,
  teacherWorksOnDay,
} from "../lib/work-days";
import { isVoucherHours, voucherExpiry, voucherUsable } from "../lib/voucher";
import { enqueueLine, type NotifyResult } from "../lib/line";
import { recordSale } from "../lib/sale-post";
import { validateSaleDiscount } from "../lib/discount-plan";
import {
  PRICES_ARE_VAT_INCLUSIVE,
  courseItemRef,
  listPriceMinor,
  revenueItemRef,
  isSellable,
  rentalPriceList,
  sellablePackages,
  voucherAllowedGroups,
  voucherAllowsProgram,
  voucherItemRef,
} from "../lib/sale-items";
import {
  drawCeilingHour,
  heldTarget,
  overLimit,
  planHoldMoves,
  reconcileDelta,
  reconcileRemaining,
  shouldCloseCeiling,
} from "../lib/freelance-budget";
import { bangkokNow } from "../lib/bangkok-time";
import {
  COURSE_LIVE,
  COURSE_LIVE_STATUSES,
  canInsert,
  courseCurrent,
  deriveLiveEndDate,
  exceedsExtensionCeiling,
  isCoursePlanRow,
  isDelivered,
  planCourseMoves,
  requiresCancelReason,
  type PlanSession,
} from "../lib/course-plan";
import { buildCourseHistory } from "../lib/course-history";
import { awardCrmPoints, notifyAdmins } from "../lib/line-admin";
import { findOrCreateParentByPhone, findParentOfStudent, suspendedStudentIds } from "./parent.service";
import {
  bookingsOrderBy,
  courseCountQuery,
  courseSearchQuery,
  studentSearchQuery,
  voucherCountQuery,
  voucherSearchQuery,
  type BookingSort,
} from "./search.queries";
import { blockedBySuspension } from "../lib/suspend";
import {
  courseEligible,
  courseRemainingSessions,
  matchesSearch,
  voucherEligible,
} from "../lib/eligibility";
import { attachBookingBadges } from "./badge.service";
import { issueCheckinToken } from "../lib/checkin-token";
import { CRM_POINT_RULES } from "../lib/crm";
import { ApiException, badRequest, conflict, notFound, pgErrorCode } from "../lib/http";
import { TIME_SLOTS, addDays, addHour, datesBetween, fmtDate, weekRange } from "../lib/time";

const DEFAULT_TEACHER_TYPE_ORDER: TeacherType[] = ["FULL_TIME", "PART_TIME", "FREELANCE"];
const TEACHER_TYPE_ORDER_KEY = "teacher_type_order";

// Persisted teacher-type ordering (B.2) — single source of truth, replaces FE localStorage.
async function readTeacherTypeOrder(exec: any = db): Promise<TeacherType[]> {
  const row = await exec.query.appSettings.findFirst({
    where: (s: any, { eq }: any) => eq(s.key, TEACHER_TYPE_ORDER_KEY),
  });
  const v = row?.value;
  return Array.isArray(v) && v.length === 3 ? (v as TeacherType[]) : DEFAULT_TEACHER_TYPE_ORDER;
}

// Rank a type by its position in `order` (unknown types sort last).
const typeRank = (order: TeacherType[], type: TeacherType) => {
  const i = order.indexOf(type);
  return i === -1 ? order.length : i;
};

// Durable per-teacher over-budget override (SPEC-001 / TASK-008), stored in app_settings so the
// booking-commit path (TASK-002) can pass allowNegative:true for a capped teacher the admin unlocked.
const LIMIT_OVERRIDE_PREFIX = "limit-override:";

async function readLimitOverride(exec: any, teacherId: string): Promise<boolean> {
  const row = await exec.query.appSettings.findFirst({
    where: (s: any, { eq }: any) => eq(s.key, `${LIMIT_OVERRIDE_PREFIX}${teacherId}`),
  });
  return row?.value === true;
}

// Batch-read every teacher's override flag → Set of teacherIds that are ON.
async function readLimitOverrides(exec: any = db): Promise<Set<string>> {
  const rows = await exec.query.appSettings.findMany({
    where: (s: any, { like }: any) => like(s.key, `${LIMIT_OVERRIDE_PREFIX}%`),
  });
  const on = new Set<string>();
  for (const r of rows) {
    if (r.value === true) on.add(r.key.slice(LIMIT_OVERRIDE_PREFIX.length));
  }
  return on;
}

// REQ-006 (TASK-024): the freelance ceiling is a `bo.item` (unit=hour) keyed by owner_ref=teacherId,
// external_source='smart-scheduler', metadata.kind='FREELANCE_CEILING'. Found directly in the shared DB.
const FREELANCE_KIND = "FREELANCE_CEILING";
const SCHED_SOURCE = "smart-scheduler";

async function findFreelanceItem(exec: any, teacherId: string) {
  return exec.query.boItem.findFirst({
    where: (i: any, { and, eq, sql }: any) =>
      and(
        eq(i.externalSource, SCHED_SOURCE),
        eq(i.ownerRef, teacherId),
        eq(i.active, true),
        sql`${i.metadata}->>'kind' = ${FREELANCE_KIND}`,
      ),
  });
}

/**
 * TASK-091 — apply ONE adjustment to ONE ceiling item. Extracted from `reconcileFreelanceDraw` so the
 * whole-booking reconcile can drive several items in a single transaction without restating the money math.
 *
 * ⚠️ The idempotency key now includes the **item**. It used to be `fl:<booking>:held<target>`, which is
 * unique per (booking, target) but NOT per item — so on a round trip A→B→A the release of B would collide
 * with the earlier release of A (both `held0`), `onConflictDoNothing` would swallow it, and the booking would
 * end up held on **two** items at once. That is exactly the round-trip off-by-one this task warned about.
 */
async function applyHoldMove(
  tx: any,
  bookingId: string,
  item: { id: string; remainingQty: number; ceilingQty: number | null; unitPriceMinor: number },
  delta: number,
  allowNegative: boolean,
) {
  if (delta > 0 && drawCeilingHour(item.remainingQty, allowNegative).blocked) {
    throw conflict(
      "INSUFFICIENT_BUDGET",
      "งบครูฟรีแลนซ์เต็มแล้ว — เติมงบหรือปลดล็อกก่อนยืนยันคาบ",
    );
  }
  const qty = -delta; // draw → −1, refund → +1
  const remainingAfter = reconcileRemaining(
    item.remainingQty,
    item.ceilingQty ?? item.remainingQty,
    delta,
  );
  await tx.update(boItem).set({ remainingQty: remainingAfter }).where(eq(boItem.id, item.id));
  await tx
    .insert(boMovement)
    .values({
      itemId: item.id,
      qty,
      remainingAfter,
      valueMinor: -qty * item.unitPriceMinor, // draw → +rate (expense); refund → −rate (un-books it)
      refType: delta > 0 ? "BOOKING" : "BOOKING_REVERSAL",
      refId: bookingId,
      idempotencyKey: `fl:${bookingId}:${item.id}:held${delta > 0 ? 1 : 0}`,
    })
    .onConflictDoNothing();
}

/**
 * 🔴 TASK-091 — reconcile a booking's freelance hold **across every item**, not just one teacher's.
 *
 * A booking must hold **at most one hour, on exactly one item — the current teacher's**. `moveBooking` used
 * to change `teacherId` with no reconcile at all, which left the old teacher's ceiling drawn for a session
 * they no longer teach *and* the new teacher's never drawn — so the new teacher could be booked **past their
 * cap**, which is the one thing the cap exists to prevent. Both directions were wrong and nothing said so.
 *
 * `heldTarget`/`reconcileDelta` still decide **how many** hours a status holds; `planHoldMoves` decides
 * **which item** holds them. No second definition of either.
 */
async function reconcileBookingHolds(
  tx: any,
  bookingId: string,
  currentTeacherId: string,
  status: string,
  override: boolean,
) {
  // Every freelance item holding this booking — including teachers it was moved away from.
  const movements = await tx.query.boMovement.findMany({
    where: (m: any, { and, eq, inArray }: any) =>
      and(eq(m.refId, bookingId), inArray(m.refType, ["BOOKING", "BOOKING_REVERSAL"])),
  });
  const heldByItem = new Map<string, number>();
  for (const m of movements) {
    heldByItem.set(m.itemId, (heldByItem.get(m.itemId) ?? 0) - m.qty); // draw qty −1 ⇒ held +1
  }

  const teacher = await tx.query.teachers.findFirst({
    where: (t: any, { eq }: any) => eq(t.id, currentTeacherId),
  });
  const currentItem =
    teacher?.type === "FREELANCE" ? await findFreelanceItem(tx, currentTeacherId) : null;
  // A ceiling with `remainingQty === null` isn't tracking hours — treat it as "no item to draw on", the
  // same carve-out `reconcileFreelanceDraw` has always made.
  const usableCurrent = currentItem && currentItem.remainingQty !== null ? currentItem : null;

  const moves = planHoldMoves(
    [...heldByItem.entries()].map(([itemId, held]) => ({ itemId, held })),
    usableCurrent?.id ?? null,
    heldTarget(status),
  );
  if (moves.length === 0) return;

  const allowNegative = override || (await readLimitOverride(tx, currentTeacherId));
  for (const move of moves) {
    const item =
      move.itemId === usableCurrent?.id
        ? usableCurrent
        : await tx.query.boItem.findFirst({ where: (i: any, { eq }: any) => eq(i.id, move.itemId) });
    if (!item || item.remainingQty === null) continue; // can't reconcile an item that isn't tracking hours
    // A release is never blocked by a cap, so `allowNegative` only matters for the draw.
    await applyHoldMove(tx, bookingId, item, move.delta, move.delta > 0 ? allowNegative : true);
  }
}

// TASK-091: the per-teacher `reconcileFreelanceDraw` was REPLACED by `reconcileBookingHolds` above.
// It only ever looked at one item, which was correct for status changes but blind to a teacher MOVE — and
// keeping both would have been two definitions of the same reconcile, one of them subtly wrong.

// Re-source the freelance budget DTO fields from the `bo.item` ceiling (hours × rate = baht, so the
// FE display — budgetMinor/remainingMinor/overLimit — is unchanged). setupIncomplete = FREELANCE with
// no ceiling item (FT/PT not gated — salary deferred).
async function attachFreelanceBudgets<
  T extends {
    id: string;
    type: TeacherType;
    archived?: boolean;
    hourlyRate?: number | null;
    budgetMinor?: number | null;
    remainingMinor?: number | null;
    reorderMinor?: number | null;
    overLimit?: boolean;
    setupIncomplete?: boolean;
  },
>(dtos: T[]): Promise<T[]> {
  const rows = await db.query.boItem.findMany({
    where: (i, { and, eq, sql }) =>
      and(
        eq(i.externalSource, SCHED_SOURCE),
        eq(i.active, true),
        sql`${i.metadata}->>'kind' = ${FREELANCE_KIND}`,
      ),
  });
  const map = new Map(rows.map((r) => [r.ownerRef, r]));
  for (const d of dtos) {
    const b = map.get(d.id);
    if (b && b.ceilingQty !== null && b.remainingQty !== null) {
      const rate = b.unitPriceMinor;
      const reorderQty =
        typeof b.metadata?.reorderQty === "number" ? (b.metadata.reorderQty as number) : null;
      d.hourlyRate = rate / 100;
      d.budgetMinor = b.ceilingQty * rate;
      d.remainingMinor = b.remainingQty * rate;
      d.reorderMinor = reorderQty !== null ? reorderQty * rate : null;
      d.overLimit = overLimit(b.remainingQty);
    }
    d.setupIncomplete = d.type === "FREELANCE" && !b && !d.archived;
  }
  return dtos;
}

/**
 * Close a teacher's freelance ceiling (REQ-009 / TASK-060) — a **consequence** of them ceasing to be freelance
 * (type change or archive), never a separate call.
 *
 * "Closed" already has a representation: `bo.item.active = false`. `findFreelanceItem`, `listFreelanceCeilings`
 * and `resetFreelanceBudgets` all filter `active = true`, so one flag removes the ceiling from enforcement, the
 * budget list and the monthly re-fill at once. **No migration, nothing deleted.**
 *
 * ⚠️ `remainingQty` / `ceilingQty` / `bo.movement` rows are deliberately **untouched** — that's what makes
 * "history is preserved" true rather than merely claimed: a past month still reports exactly what it did.
 * No-op when the teacher has no active item (FT/PT who never had one, or already closed).
 */
async function closeFreelanceCeiling(exec: any, teacherId: string) {
  const item = await findFreelanceItem(exec, teacherId);
  if (!item) return; // nothing to close
  await exec.update(boItem).set({ active: false }).where(eq(boItem.id, item.id));
}

/**
 * Every freelance ceiling with its remaining HOURS — the same `bo.item` rows (and the same `remainingQty`)
 * the calendar's `overLimit` reads. Exported so the attention checks (TASK-053) reuse this one source instead
 * of re-deriving "over cap".
 */
export async function listFreelanceCeilings(): Promise<
  Array<{ teacherId: string; nickname: string; remainingQty: number }>
> {
  const items = await db.query.boItem.findMany({
    where: (i, { and, eq, sql }) =>
      and(
        eq(i.externalSource, SCHED_SOURCE),
        eq(i.active, true),
        sql`${i.metadata}->>'kind' = ${FREELANCE_KIND}`,
      ),
  });
  const rows = await db.query.teachers.findMany({
    where: (t, { eq }) => eq(t.archived, false),
  });
  const byId = new Map(rows.map((t) => [t.id, t]));
  return items
    .filter((i) => i.ownerRef && i.remainingQty !== null && byId.has(i.ownerRef))
    .map((i) => ({
      teacherId: i.ownerRef!,
      nickname: byId.get(i.ownerRef!)!.nickname,
      remainingQty: i.remainingQty!,
    }));
}

/** Booking gate: a FREELANCE teacher with no ceiling item can't be booked; FT/PT ok. */
async function isFreelanceSetupIncomplete(exec: any, teacherId: string, type: TeacherType) {
  if (type !== "FREELANCE") return false;
  const b = await findFreelanceItem(exec, teacherId);
  return !b;
}

const withBookingRelations = {
  student: true,
  teacher: true,
  subject: true,
  course: true,
  badges: { with: { value: true, type: true } },
} as const;

async function loadBookingDTO(exec: any, id: string) {
  const row = await exec.query.bookings.findFirst({
    where: (b: any, { eq }: any) => eq(b.id, id),
    with: withBookingRelations,
  });
  return toBookingDTO(row);
}

// ───────────────────────────── Reads ─────────────────────────────

export async function getCalendar(input: { date: string; view: "day" | "week" }) {
  const range = input.view === "week" ? weekRange(input.date) : { start: input.date, end: input.date };
  const days = datesBetween(range.start, range.end);

  const [teacherRows, order] = await Promise.all([
    db.query.teachers.findMany({
      where: (t, { eq }) => eq(t.active, true),
      with: { teacherSubjects: { with: { subject: true } } },
    }),
    readTeacherTypeOrder(),
  ]);
  const teacherDtos = teacherRows
    .map(toTeacherDTO)
    .sort(
      (a, b) =>
        typeRank(order, a.type) - typeRank(order, b.type) ||
        a.nickname.localeCompare(b.nickname, "th"),
    );
  await attachFreelanceBudgets(teacherDtos); // SPEC-005: local budget + setupIncomplete (no ops)
  const overrides = await readLimitOverrides();
  for (const d of teacherDtos) d.limitOverride = overrides.has(d.id);

  const bookingRows = await db.query.bookings.findMany({
    where: (b, { and, eq, gte, lte, ne }) =>
      and(
        gte(b.date, range.start),
        lte(b.date, range.end),
        ne(b.status, "CANCELLED"),
        // Hide bookings still waiting for an overbooked slot (B.1) — the grid shows
        // the existing PENDING_RESCHEDULE occupant until the move is confirmed.
        eq(b.pendingSlot, false),
      ),
    with: withBookingRelations,
  });

  const idx = new Map<string, ReturnType<typeof toBookingDTO>>();
  for (const row of bookingRows) {
    const dto = toBookingDTO(row);
    const key = `${dto.date}|${dto.teacher.id}|${dto.startTime}`;
    const cur = idx.get(key);
    // Overbooking a leave slot (UC-004): an active booking can now share a slot with
    // the SICK_LEAVE record it replaced — surface the active booking, not the leave one.
    if (!cur || (cur.status === "SICK_LEAVE" && dto.status !== "SICK_LEAVE")) {
      idx.set(key, dto);
    }
  }

  return {
    view: input.view,
    range: { from: range.start, to: range.end },
    timeSlots: [...TIME_SLOTS],
    days: days.map((date) => {
      const weekday = weekdayOf(date);
      const columns = teacherDtos
        .filter((teacher) => teacherWorksOnDay(teacher.workDays, weekday))
        .map((teacher) => ({
          teacher,
          slots: TIME_SLOTS.map((time) => ({
            time,
            booking: idx.get(`${date}|${teacher.id}|${time}`) ?? null,
          })),
        }));
      return { date, columns };
    }),
  };
}

export async function getTeachers(opts: { archived?: boolean } = {}) {
  const [rows, order] = await Promise.all([
    db.query.teachers.findMany({
      where: (t, { eq }) => eq(t.archived, opts.archived ?? false),
      with: { teacherSubjects: { with: { subject: true } } },
    }),
    readTeacherTypeOrder(),
  ]);
  const dtos = await attachFreelanceBudgets(rows.map(toTeacherDTO)); // SPEC-005 (local)
  const overrides = await readLimitOverrides();
  for (const d of dtos) d.limitOverride = overrides.has(d.id);
  return {
    groups: order.map((type) => {
      const list = dtos
        .filter((t) => t.type === type)
        .sort((a, b) => a.nickname.localeCompare(b.nickname, "th"));
      return { type, allActive: list.length > 0 && list.every((t) => t.active), teachers: list };
    }),
  };
}

// ───────────────────── Teacher type order (B.2) ─────────────────────

export async function getTeacherTypeOrder() {
  return { order: await readTeacherTypeOrder() };
}

export async function setTeacherTypeOrder(order: TeacherType[]) {
  await db
    .insert(appSettings)
    .values({ key: TEACHER_TYPE_ORDER_KEY, value: order })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: order } });
  return { order };
}

/**
 * Course ids in the ONE canonical order — student name, then the course's own `createdAt`, then id as a final
 * tiebreak so the sequence is total. Ordering lives here rather than at the call sites, because "the same
 * request returns the same order" is what makes paging mean anything (before this there was no `ORDER BY` at
 * all, so identical requests could return cards in different orders).
 *
 * ⚠️ `leftJoin(parents)`: the phone half of the search rule needs the parent row, but a walk-in student
 * legitimately has none — an inner join would hide every parentless student from the list *and* the search.
 */
async function courseIdsOrdered(f: { q?: string; page?: number; limit?: number } = {}) {
  const base = courseSearchQuery(f.q);
  const rows =
    f.page && f.limit ? await base.limit(f.limit).offset((f.page - 1) * f.limit) : await base;
  return rows.map((r) => r.id);
}

/** Hydrate courses to their DTO shape, preserving the id order handed in. */
async function coursesByIds(ids: string[]) {
  if (ids.length === 0) return [];
  // TASK-140: the course's own `subject` is the program. The one-booking load stays only as the pre-0018
  // fallback the mapper falls through to (a course ⇔ one subject; REQ-010).
  const rows = await db.query.coursePackages.findMany({
    where: (c, { inArray: inA }) => inA(c.id, ids),
    with: { student: true, subject: true, bookings: { with: { subject: true }, limit: 1 } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toCourseWithStudent(row)] : [];
  });
}

/**
 * **Every** course, unpaged — the shape three internal consumers depend on (attention checks TASK-053,
 * eligible-students TASK-051, the SOM report TASK-062). Paging this would silently truncate a digest count,
 * an eligibility list and a dashboard figure, so paging is **opt-in via `listCoursesPaged`** instead.
 * The only change here is that the order is now deterministic.
 */
export async function getCourses() {
  return coursesByIds(await courseIdsOrdered());
}

/** The `/courses` tab: same rows, same order, plus the shared search rule and paging. */
export async function listCoursesPaged(f: { q?: string; page: number; limit: number }) {
  const [ids, [{ value: total }]] = await Promise.all([
    courseIdsOrdered(f),
    courseCountQuery(f.q),
  ]);
  return { items: await coursesByIds(ids), page: f.page, limit: f.limit, total };
}

/**
 * Students who can be booked against an existing entitlement, with the context staff need to choose
 * (REQ-022 / TASK-051). Reuses `getCourses()` / `getVouchers()` and the pure eligibility rules — no new joins,
 * no second definition of "active".
 *
 * A student with two active courses/vouchers appears **once per entitlement** (staff pick which).
 * `FIRST_TRIAL` / `SINGLE_SESSION` are deliberately not served here — those keep `GET /students?q=`, since any
 * student (including a brand-new one) is valid for them.
 */
export async function getEligibleStudents(type: string, q?: string) {
  const { date } = bangkokNow();
  // REQ-019 / TASK-056: this endpoint exists ONLY to answer "who can be booked", so a suspended household
  // never belongs in it — filtered unconditionally. Parentless walk-in students are never in the set.
  const suspended = await suspendedStudentIds();

  // TASK-088 — `q` resolves through the SAME rule as /students and /bookings (`studentSearchConditions`,
  // via `searchStudentIds`), so one term finds the same child on all three surfaces. Resolving to ids and
  // intersecting is what lets us match a **parent phone** without putting the phone in this response — the
  // payload is deliberately `{id, name, nickname, context}` and adding PII to it would be the REQ-020 mistake.
  // ⚠️ `searchStudentIds` LEFT joins parents, so a parentless walk-in still matches on name/nickname.
  const matching = q?.trim() ? new Set(await searchStudentIds(q)) : null;

  if (type === "COURSE_PACKAGE") {
    const courses = await getCourses();
    return {
      students: courses
        .filter(
          (c: any) =>
            courseEligible(c, date) &&
            !suspended.has(c.student.id) &&
            matchesSearch(c.student.id, matching),
        )
        .map((c: any) => ({
          id: c.student.id,
          name: c.student.name,
          nickname: c.student.nickname ?? null,
          context: {
            courseId: c.id,
            subject: c.subject ?? null,
            size: c.size,
            usedSessions: c.usedSessions,
            remainingSessions: courseRemainingSessions(c),
            leaveUsed: c.leaveUsed,
            leaveQuota: c.leaveQuota,
            expiryDate: c.expiryDate,
          },
        })),
    };
  }

  if (type === "VOUCHER") {
    const vouchers = await getVouchers();
    return {
      students: vouchers
        .filter(
          (v: any) =>
            voucherEligible(v, date) &&
            !suspended.has(v.student.id) &&
            matchesSearch(v.student.id, matching),
        )
        .map((v: any) => ({
          id: v.student.id,
          name: v.student.name,
          nickname: v.student.nickname ?? null,
          context: {
            voucherId: v.id,
            totalHours: v.totalHours,
            usedHours: v.usedHours,
            remainingHours: v.remaining,
            expiryDate: v.expiryDate,
          },
        })),
    };
  }

  throw badRequest("type ต้องเป็น COURSE_PACKAGE หรือ VOUCHER");
}

/**
 * Resolve a free-text student search to ids using the **one** shared rule — name · nickname · parent phone
 * (`studentSearchConditions`, REQ-011). Courses/vouchers apply the same rule inside their own joins.
 *
 * ⚠️ **LEFT join, and it must stay one.** A walk-in / First-Trial student has `parent_id = null` **by design**;
 * an inner join here would delete the entire walk-in cohort from every search box in the app.
 */
async function searchStudentIds(q: string): Promise<string[]> {
  return (await studentSearchQuery(q)).map((r) => r.id);
}

export async function getBookings(f: {
  from?: string;
  to?: string;
  type?: any;
  status?: any;
  teacherId?: string;
  q?: string;
  sort?: BookingSort;
  page: number;
  limit: number;
}) {
  // q searches student & subject names → resolve to ids first (keeps it one query each)
  let studentIds: string[] | null = null;
  let subjectIds: string[] | null = null;
  if (f.q) {
    studentIds = await searchStudentIds(f.q);
    subjectIds = (
      await db.select({ id: subjects.id }).from(subjects).where(ilike(subjects.name, `%${f.q}%`))
    ).map((r) => r.id);
  }

  const conds: any[] = [];
  if (f.type) conds.push(eq(bookings.bookingType, f.type));
  if (f.status) conds.push(eq(bookings.status, f.status));
  if (f.teacherId) conds.push(eq(bookings.teacherId, f.teacherId));
  if (f.from) conds.push(gte(bookings.date, f.from));
  if (f.to) conds.push(lte(bookings.date, f.to));
  if (f.q) {
    const ors: any[] = [];
    if (studentIds?.length) ors.push(inArray(bookings.studentId, studentIds));
    if (subjectIds?.length) ors.push(inArray(bookings.subjectId, subjectIds));
    conds.push(ors.length ? or(...ors) : sql`false`);
  }
  const cond = conds.length ? and(...conds) : sql`true`;

  const rows = await db
    .select({ b: bookings, s: students, t: teachers, sub: subjects, c: coursePackages })
    .from(bookings)
    .innerJoin(students, eq(students.id, bookings.studentId))
    .innerJoin(teachers, eq(teachers.id, bookings.teacherId))
    .innerJoin(subjects, eq(subjects.id, bookings.subjectId))
    .leftJoin(coursePackages, eq(coursePackages.id, bookings.courseId))
    .where(cond)
    // TASK-073: default `upcoming` — today/future soonest-first, then the past most-recent-first.
    // Pure sort: nothing is filtered out, so `total` still matches the filtered set in every direction.
    .orderBy(...bookingsOrderBy(f.sort ?? "upcoming", bangkokNow().date))
    .limit(f.limit)
    .offset((f.page - 1) * f.limit);

  const [{ value: total }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(bookings)
    .where(cond);

  return {
    items: rows.map((r) =>
      toBookingDTO({ ...r.b, student: r.s, teacher: r.t, subject: r.sub, course: r.c }),
    ),
    page: f.page,
    limit: f.limit,
    total,
  };
}

export async function getDailyReport(date: string) {
  const rows = await db
    .select({ status: bookings.status, bookingType: bookings.bookingType })
    .from(bookings)
    .where(and(eq(bookings.date, date), eq(bookings.pendingSlot, false)));

  const count = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).length;
  const types = ["FIRST_TRIAL", "SINGLE_SESSION", "COURSE_PACKAGE", "VOUCHER"] as const;

  return {
    date,
    totalBooked: count((r) => r.status !== "CANCELLED"),
    attended: count((r) => r.status === "ATTENDED"),
    onLeave: count((r) => r.status === "SICK_LEAVE"),
    noShow: count((r) => r.status === "NO_SHOW"),
    pending: count((r) => r.status === "PENDING"),
    cancelled: count((r) => r.status === "CANCELLED"),
    byBookingType: types.map((type) => ({ type, count: count((r) => r.bookingType === type) })),
  };
}

// ───────────────────────────── Writes ─────────────────────────────

// Existing id → use it; inline new student → insert. A phone find-or-creates the
// parent (guardian) and attaches the student to it.
async function resolveStudentId(exec: any, student: any): Promise<string> {
  if ("id" in student) return student.id;
  const parent = student.phone
    ? await findOrCreateParentByPhone(student.phone, {}, exec)
    : null;
  const [s] = await exec
    .insert(students)
    .values({
      name: student.name,
      nickname: student.nickname ?? student.name,
      parentId: parent?.id ?? null,
    })
    .returning({ id: students.id });
  return s.id;
}

// Insert one booking; endTime is derived (+1h), slot clashes → 409. `pendingSlot`
// marks the new booking that is waiting for an overbooked slot to be released.
/** Suspension message — one string for booking and buying, so a household never sees two wordings for one
 *  policy. (TASK-048 wrote the booking half; TASK-058 shares it with the sale paths.) */
const SUSPENDED_MESSAGE = "บัญชีผู้ปกครองถูกระงับ — ติดต่อเจ้าหน้าที่เพื่อเปิดใช้งานก่อน";

/** Refuse a purchase when the student's household is suspended (TASK-058). Walk-in students with no parent
 *  are never blocked — same carve-out as the booking gate, via the same `blockedBySuspension`. */
async function assertHouseholdNotSuspended(exec: any, studentId: string) {
  if (blockedBySuspension(await findParentOfStudent(studentId, exec))) {
    throw badRequest(SUSPENDED_MESSAGE);
  }
}

/**
 * The teacher-availability gate for a booking landing on `date`: teacher exists, not archived, works that
 * weekday, and (if FREELANCE) has a budget set. ONE definition — used by `insertBooking` (new bookings),
 * `moveBooking` and `applyPlanChange` (per-session edits) so a move can't skip what an insert enforces.
 */
async function assertTeacherBookable(exec: any, teacherId: string, date: string) {
  const teacher = await exec.query.teachers.findFirst({
    where: (t: any, { eq }: any) => eq(t.id, teacherId),
  });
  if (!teacher) throw badRequest("ไม่พบครู");
  if (teacher.archived) throw badRequest(`ครู${teacher.nickname} ถูกปิดการใช้งานแล้ว`);
  if (!teacherWorksOnDay(teacher.workDays, weekdayOf(date))) {
    throw badRequest(`ครู${teacher.nickname} ไม่มาสอนวันนี้`);
  }
  // SPEC-005 server backstop to the FE `bookable` gate: a FREELANCE teacher with no budget row can't be
  // booked (FT/PT are not gated — salary deferred).
  if (await isFreelanceSetupIncomplete(exec, teacher.id, teacher.type)) {
    throw badRequest(`ครู${teacher.nickname} ยังไม่ได้ตั้งงบ — ตั้งงบก่อนจึงจะจองได้`);
  }
  return teacher;
}

async function insertBooking(
  exec: any,
  studentId: string,
  input: any,
  opts: { pendingSlot?: boolean } = {},
): Promise<string> {
  await assertTeacherBookable(exec, input.teacherId, input.date);
  // REQ-019 / TASK-048: a suspended household gets no NEW bookings (existing ones are untouched). Server-side,
  // so hiding the button in the UI isn't the only defence. Walk-in students with no parent are never blocked.
  if (blockedBySuspension(await findParentOfStudent(studentId, exec))) {
    throw badRequest(`${SUSPENDED_MESSAGE}จอง`);
  }
  // SPEC-030 / TASK-106: a voucher can't book Onewheel or Balance Play (course-only programs). Enforced here —
  // insertBooking is the single chokepoint every VOUCHER booking passes. A null/unknown group is refused too
  // (same null-group path, no special case for 1st Trial). Already-sold voucher hours are untouched (AC #5).
  if (input.bookingType === "VOUCHER" && !voucherAllowsProgram(await resolvePriceGroup(input.subjectId, exec))) {
    throw conflict("VOUCHER_PROGRAM_EXCLUDED", "วอยเชอร์ใช้กับคลาส Onewheel หรือ Balance Play ไม่ได้");
  }
  // REQ-061 / TASK-158 (AC-6/AC-7): a single paid hour only exists where the card prices one. For bike/skate
  // there is no 1-hour rate — a first single hour there is **1st Trial** — so booking one would create a session
  // nobody can price, and the revenue post would have to invent a number. `isSellable(group, 1)` is the
  // catalogue's own test, deliberately not a second list that could drift from it.
  if (input.bookingType === "SINGLE_SESSION" && !isSellable(await resolvePriceGroup(input.subjectId, exec), 1)) {
    throw conflict(
      "SINGLE_SESSION_NOT_PRICED",
      "โปรแกรมนี้ไม่มีราคาแบบรายชั่วโมง — ครั้งแรกให้ใช้ 1st Trial หรือขายเป็นคอร์ส/บัตร " +
        "(This program has no single-hour price — use 1st Trial for a first session, or sell a course/voucher.)",
    );
  }

  try {
    const [row] = await exec
      .insert(bookings)
      .values({
        studentId,
        teacherId: input.teacherId,
        subjectId: input.subjectId,
        date: input.date,
        startTime: input.startTime,
        endTime: addHour(input.startTime),
        bookingType: input.bookingType,
        // TASK-148: a course created with a week already marked absent inserts that row `SICK_LEAVE` +
        // `plannedAtCreation` straight away. Everything else keeps the PENDING default.
        status: input.status ?? "PENDING",
        plannedAtCreation: input.plannedAtCreation ?? false,
        courseId: input.courseId ?? null,
        voucherId: input.voucherId ?? null,
        note: input.note ?? null,
        pendingSlot: opts.pendingSlot ?? false,
      })
      .returning({ id: bookings.id });
    return row.id;
  } catch (e: any) {
    const code = pgErrorCode(e);
    if (code === "23505") throw conflict("SLOT_TAKEN", "ครูมีคาบในช่วงเวลานี้แล้ว");
    if (code === "23503") throw badRequest("teacher / subject / course อ้างอิงไม่ถูกต้อง");
    throw e;
  }
}

// Voucher enforcement (B.5): the first booking sets the validity window; every
// booking must have hours left and fall before expiry. No teacher restriction here
// — "can't pick a teacher" is a purchase-time rule, not a per-session one.
async function prepareVoucherBooking(exec: any, voucherId: string, date: string, studentId: string) {
  const v = await exec.query.vouchers.findFirst({
    where: (x: any, { eq }: any) => eq(x.id, voucherId),
  });
  if (!v) throw badRequest("ไม่พบวอยเชอร์");
  if (v.studentId !== studentId) throw badRequest("วอยเชอร์นี้ไม่ใช่ของนักเรียนที่เลือก");

  const prior = await exec.query.bookings.findFirst({
    where: (b: any, { and, eq, ne }: any) =>
      and(eq(b.voucherId, voucherId), ne(b.status, "CANCELLED")),
  });
  let expiryDate = v.expiryDate;
  if (!prior) {
    expiryDate = voucherExpiry(v.totalHours, date); // count validity from the first booking
    await exec.update(vouchers).set({ expiryDate }).where(eq(vouchers.id, voucherId));
  }
  const check = voucherUsable({ totalHours: v.totalHours, usedHours: v.usedHours, expiryDate }, date);
  if (!check.ok) throw badRequest(check.reason!);
}

/**
 * TASK-162: validate a trial/single session's discount at BOOKING time and return the columns to store.
 *
 * The rule is the SAME `planDiscount` the at-sale path uses — one definition of a valid discount, so the two
 * moments can never disagree. Only FIRST_TRIAL and SINGLE_SESSION reach day-end posting; a discount asked for
 * on any other booking type is refused rather than silently stored and never applied.
 */
async function captureBookingDiscount(input: any) {
  if (!input?.discount) return undefined;
  if (input.bookingType !== "FIRST_TRIAL" && input.bookingType !== "SINGLE_SESSION") {
    throw badRequest("ส่วนลดสำหรับคาบเดี่ยว/ทดลองเท่านั้น — คอร์สและบัตรให้ลดตอนขาย");
  }
  const priceGroup = await resolvePriceGroup(input.subjectId);
  const ref = revenueItemRef(input.bookingType, priceGroup);
  // No price ⇒ no line total ⇒ nothing a discount could be a percentage OF. Refuse rather than guess.
  const lineTotalMinor = ref ? listPriceMinor(ref) : undefined;
  const validated = validateSaleDiscount(input.discount, lineTotalMinor ?? 0, input.actor ?? null);
  if (!validated) return undefined;
  return {
    discountKind: input.discount.kind,
    discountValue: input.discount.value,
    discountReason: validated.reason,
    discountActor: validated.actor,
  };
}

export async function createBooking(input: any) {
  // SPEC-059 / TASK-162 (REQ-063): a trial/single session's revenue posts at DAY-END, when no admin is present.
  // The admin is present HERE, so the discount is validated and captured now — against this booking's own line
  // total (one hour at its program's rate) — and the day-end job only posts what was already authorised.
  // Validated before the booking exists, so an invalid discount refuses the booking rather than storing junk.
  const discountCapture = await captureBookingDiscount(input);
  return await db.transaction(async (tx) => {
    const studentId = await resolveStudentId(tx, input.student);
    if (input.bookingType === "VOUCHER" && input.voucherId) {
      await prepareVoucherBooking(tx, input.voucherId, input.date, studentId);
    }
    const id = await insertBooking(tx, studentId, input);
    if (discountCapture) {
      await tx.update(bookings).set(discountCapture).where(eq(bookings.id, id));
    }
    if (input.badgeValueIds?.length) {
      await attachBookingBadges(tx, id, input.badgeValueIds);
    }
    const booking = await loadBookingDTO(tx, id);
    return { booking, course: booking.course };
  });
}

/**
 * SPEC-033 / TASK-112 (REQ-037) — add a one-time EXTRA paid session to a course. It is a normal `SINGLE_SESSION`
 * booking, **soft-linked** to the course by `courseId` (so it shows on the course view), but the SPEC-033 seam-keeper
 * (`bookingType === "COURSE_PACKAGE"` filter in the course engine) guarantees it never counts toward size/owed/end
 * and its cancel never re-owes. Reuses `createBooking` → `insertBooking`, so availability/clash/freelance-set gates,
 * freelance drawdown on confirm, and day-end single-session revenue are all the existing paths — no new mechanism.
 */
export async function addExtraSession(
  courseId: string,
  input: { teacherId: string; subjectId: string; date: string; startTime: string },
) {
  const course = await db.query.coursePackages.findFirst({ where: (c, { eq }) => eq(c.id, courseId) });
  if (!course) throw notFound("ไม่พบคอร์ส");
  if (!course.studentId) throw badRequest("คอร์สนี้ไม่มีนักเรียนที่ผูกไว้");
  return createBooking({
    student: { id: course.studentId },
    teacherId: input.teacherId,
    subjectId: input.subjectId,
    date: input.date,
    startTime: input.startTime,
    bookingType: "SINGLE_SESSION",
    courseId, // soft link — visible on the course view; the engine ignores it (SPEC-033 §2)
  });
}

/**
 * A program's price group (TASK-077). `null` when the subject has none — the caller must refuse loudly
 * rather than fall back to a default price.
 */
export async function resolvePriceGroup(subjectId: string, exec: any = db): Promise<string | null> {
  const row = await exec.query.subjects.findFirst({
    where: (s: any, { eq: e }: any) => e(s.id, subjectId),
  });
  return row?.priceGroup ?? null;
}

/** The combinations that exist, for `GET /api/sellable-packages` — with each program that sells on them. */
export async function getSellablePackages() {
  const rows = await db.select().from(subjects);
  const packages = sellablePackages();
  return {
    vatInclusive: PRICES_ARE_VAT_INCLUSIVE,
    packages: packages.map((p) => ({
      ...p,
      subjects: rows
        .filter((s) => s.priceGroup === p.priceGroup && s.active)
        .map((s) => ({ id: s.id, name: s.name })),
    })),
    // Named so the FE can show "this program has no price group yet" instead of an empty dropdown.
    unpricedSubjects: rows
      .filter((s) => s.active && !s.priceGroup)
      .map((s) => ({ id: s.id, name: s.name })),
    // SPEC-030 / TASK-106 — the programs a voucher may book, so the FE picker filters from here (not a hardcoded list).
    voucherAllowedGroups: voucherAllowedGroups(),
    // SPEC-031 / TASK-123 — rental prices (code + VAT-incl priceMinor) from the one authority; FE owns the labels.
    rentalItems: rentalPriceList(),
  };
}

// ─────────────────── Import an in-progress entitlement (SPEC-025 / TASK-079) ───────────────────
//
// 🔴 **A separate VERB, not a flag on the sale path.** Since TASK-066 revenue posts at the point of sale, so
// anything that creates entitlement *through* the sale path inherits that. Importing ~30 families behind a
// `skipRevenue: true` boolean would post a large, entirely fictional month of revenue — money collected months
// ago, counted again — and a boolean is one forgotten default away from exactly that, in the week everyone is
// watching something else. **Two verbs cannot be confused; a flag can.**
//
// ⚠️ Neither function calls `recordSale`. That is the point, and there is a test asserting no `bo.movement`
// row appears.

/**
 * Import a course a family is already part-way through: `size` bought, `usedSessions` already taught,
 * bookings created for the **remainder only**.
 *
 * ⚠️ **`expiryDate` is taken, never computed.** `courseExpiry` counts from the start date, and an imported
 * course started months ago — computing it would silently extend or shorten what the family actually bought.
 *
 * ⚠️ Pricing and availability (SPEC-024) deliberately do **not** apply: nothing is being sold, and an
 * off-card size is importable **on purpose** — the family already bought it, whatever the card says today.
 */
export async function importCoursePackage(input: any) {
  const remaining = remainingSessions(input.size, input.usedSessions);
  return await db.transaction(async (tx) => {
    const studentId = await resolveStudentId(tx, input.student);
    // Import does not bypass the suspend gate — a suspended household is refused loudly, as everywhere else.
    await assertHouseholdNotSuspended(tx, studentId);

    const [course] = await tx
      .insert(coursePackages)
      .values({
        studentId,
        size: input.size,
        subjectId: input.subjectId, // TASK-140 — an import records its program too, or it would be the one
        usedSessions: input.usedSessions, // course left deriving it from a booking
        startDate: input.startDate,
        weekday: weekdayOf(input.startDate),
        startTime: input.startTime,
        expiryDate: input.expiryDate, // taken, not computed
        source: "IMPORT",
      })
      .returning({ id: coursePackages.id });

    // The remaining sessions only. We deliberately do NOT create the ones already taught: we don't have that
    // history, and the balance is the point — inventing past bookings to make a number look right would put
    // fictional attendance in the reports.
    for (const date of courseSessionDates(input.startDate, remaining)) {
      try {
        await insertBooking(tx, studentId, {
          teacherId: input.teacherId,
          subjectId: input.subjectId,
          date,
          startTime: input.startTime,
          bookingType: "COURSE_PACKAGE",
          courseId: course.id,
          note: input.note,
        });
      } catch (e: any) {
        if (e?.code === "SLOT_TAKEN")
          throw conflict("SLOT_TAKEN", `มีคาบชนในวันที่ ${date} — เลือกวัน/เวลาอื่นสำหรับคอร์สนี้`);
        throw e;
      }
    }

    const courseRow = await tx.query.coursePackages.findFirst({
      where: (c, { eq: e }) => e(c.id, course.id),
      with: { student: true },
    });
    return { course: toCourseWithStudent(courseRow), remaining };
  });
}

/** Import a voucher with hours already used. Same rules: explicit expiry, no revenue, suspend gate applies. */
export async function importVoucher(input: any) {
  return await db.transaction(async (tx) => {
    const studentId = await resolveStudentId(tx, input.student);
    await assertHouseholdNotSuspended(tx, studentId);
    const [row] = await tx
      .insert(vouchers)
      .values({
        studentId,
        totalHours: input.totalHours,
        usedHours: input.usedHours,
        expiryDate: input.expiryDate, // taken, not computed
        source: "IMPORT",
      })
      .returning({ id: vouchers.id });
    const voucher = await tx.query.vouchers.findFirst({
      where: (v, { eq: e }) => e(v.id, row.id),
      with: { student: true },
    });
    return {
      voucher: toVoucherDTO(voucher),
      remaining: remainingSessions(input.totalHours, input.usedHours),
    };
  });
}

// ───────────────────── Course package + voucher (B.4 / B.5) ─────────────────────

// Register a 4/6/10-session course: create the package and lock its weekly slots
// forward (auto-recurring). A clash on any week aborts the whole registration.
export async function createCoursePackage(input: any) {
  if (!isCourseSize(input.size)) throw badRequest("ขนาดคอร์สต้องเป็น 4, 6 หรือ 10");
  // TASK-077 — resolve the program's price group up front and refuse BEFORE creating anything if this
  // (program, size) isn't on the card. Onewheel has no 10 h and Balance Play has no 4 h; staff could
  // previously sell those, and the sale would then post a price the owner doesn't charge.
  // A subject with no price_group is refused too — it must never fall back to a default price.
  const priceGroup = await resolvePriceGroup(input.subjectId);
  if (!priceGroup) {
    throw badRequest(
      "โปรแกรมนี้ยังไม่ได้ตั้งกลุ่มราคา — ตั้งค่าก่อนจึงจะขายคอร์สได้ (subjects.price_group)",
    );
  }
  if (!isSellable(priceGroup, input.size)) {
    throw badRequest(`โปรแกรมนี้ไม่มีแพ็กเกจ ${input.size} ชั่วโมงตามราคาที่กำหนด`);
  }
  // SPEC-059 / TASK-160 (REQ-063): validate the discount HERE — before the course, its bookings, or any money
  // exists. An invalid discount must refuse the whole sale (refuse-never-clamp), and the only way to guarantee
  // that is to fail before the first write, not to unwind afterwards. Validated against the LIST price of the
  // exact item this sale will post to (AC-14: the line total, which for a course is one unit).
  const discount = validateSaleDiscount(
    input.discount,
    listPriceMinor(courseItemRef(priceGroup, input.size)) ?? 0,
    input.actor ?? null,
  );
  const result = await db.transaction(async (tx) => {
    const studentId = await resolveStudentId(tx, input.student);
    // TASK-058: a suspended household may not BUY. Explicit here — the booking gate inside insertBooking would
    // reject the generated sessions anyway, but incidental enforcement stops being enforcement the moment
    // someone reorders this or adds a course type that books no sessions.
    await assertHouseholdNotSuspended(tx, studentId);
    const [course] = await tx
      .insert(coursePackages)
      .values({
        studentId,
        size: input.size,
        subjectId: input.subjectId, // TASK-140: the course's program, recorded — not derived from a booking
        startDate: input.startDate,
        weekday: weekdayOf(input.startDate),
        startTime: input.startTime,
        expiryDate: courseExpiry(input.startDate, input.size),
      })
      .returning({ id: coursePackages.id });

    // TASK-095 — an optional per-session plan (purchase-time modal). Each row overrides teacher/subject/time;
    // absent ⇒ today's uniform weekly chain (back-compat). Either way it commits in this one clash-aborts-all tx.
    const plannedSessions: Array<{ teacherId: string; subjectId: string; date: string; startTime: string }> =
      input.sessions?.length
        ? input.sessions.map((s: any) => ({
            teacherId: s.teacherId ?? input.teacherId,
            subjectId: s.subjectId ?? input.subjectId,
            date: s.date,
            startTime: s.startTime ?? input.startTime,
          }))
        : courseSessionDates(input.startDate, input.size).map((date: string) => ({
            teacherId: input.teacherId,
            subjectId: input.subjectId,
            date,
            startTime: input.startTime,
          }));

    // SPEC-045 / TASK-138 (REQ-054): defensive second layer — the zod refine already rejects a mixed request,
    // but every session that lands in this course must share one program, whatever path built the plan.
    if (new Set(plannedSessions.map((s) => s.subjectId)).size !== 1) {
      throw badRequest("ทุกคาบในคอร์สต้องเป็นกิจกรรมเดียวกัน");
    }

    // SPEC-049 / TASK-148 (REQ-045 B): weeks the family already knows they'll miss, declared at creation.
    // 1-based week numbers against `plannedSessions`; each becomes a `SICK_LEAVE` row flagged
    // `plannedAtCreation`, and the reconcile engine below appends the make-up so live sessions == size.
    const absentWeeks = new Set<number>((input.absentWeeks ?? []) as number[]);

    for (const [i, s] of plannedSessions.entries()) {
      const absent = absentWeeks.has(i + 1);
      try {
        await insertBooking(tx, studentId, {
          ...(absent ? { status: "SICK_LEAVE" as const, plannedAtCreation: true } : {}),
          teacherId: s.teacherId,
          subjectId: s.subjectId,
          date: s.date,
          startTime: s.startTime,
          bookingType: "COURSE_PACKAGE",
          courseId: course.id,
          note: input.note,
        });
      } catch (e: any) {
        if (e?.code === "SLOT_TAKEN")
          throw conflict("SLOT_TAKEN", `มีคาบชนในวันที่ ${s.date} — เลือกวัน/เวลาอื่นสำหรับคอร์สนี้`);
        throw e;
      }
    }

    // TASK-148: ONE behaviour — the same engine the plan editor uses appends the make-ups, so a course born
    // with absences ends up with `size` live sessions and a later end date. It is also where the MAX_WEEK
    // ceiling is enforced (`EXTENSION_CEILING`): if the declared absences push the course past its ceiling the
    // whole create is refused with that reason and this transaction rolls back — nothing is trimmed silently.
    // `leaveUsed` is deliberately NOT touched: an absence declared at creation is free (owner decision B).
    if (absentWeeks.size) await reconcileCoursePlan(tx, course.id);

    const courseRow = await tx.query.coursePackages.findFirst({
      where: (c, { eq }) => eq(c.id, course.id),
      with: { student: true },
    });
    const created = await tx.query.bookings.findMany({
      where: (b, { eq }) => eq(b.courseId, course.id),
      with: withBookingRelations,
      orderBy: (b, { asc }) => asc(b.date),
    });
    return { course: toCourseWithStudent(courseRow), bookings: created.map(toBookingDTO) };
  });

  // Phase 2 (item-centric): a course sale → record revenue on its INCOME item in backoffice.
  // Best-effort; no-op if the "course-{size}" income item isn't set up yet.
  void recordSale(courseItemRef(priceGroup, input.size), 1, {
    refId: result.course.id,
    idempotencyKey: `course-sale:${result.course.id}`,
    discount, // TASK-160 — validated at the top of this function, BEFORE the course was written
  });

  return result;
}

// List vouchers for the voucher tab + the booking picker. Optional studentId
// (booking modal loads a student's own vouchers) / q (name search).
/**
 * Voucher ids, newest first (`id` breaks ties so the order is total and paging is stable).
 *
 * ⚠️ `leftJoin(parents)` for the same reason as courses: a walk-in student has no parent row and must still
 * be findable by name/nickname.
 */
async function voucherIdsOrdered(
  f: { studentId?: string; q?: string; page?: number; limit?: number } = {},
) {
  const base = voucherSearchQuery(f);
  const rows =
    f.page && f.limit ? await base.limit(f.limit).offset((f.page - 1) * f.limit) : await base;
  return rows.map((r) => r.id);
}

async function vouchersByIds(ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await db.query.vouchers.findMany({
    where: (v, { inArray: inA }) => inA(v.id, ids),
    with: { student: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toVoucherDTO(row)] : [];
  });
}

/**
 * All matching vouchers, unpaged — same opt-in contract as `getCourses` (attention checks, eligible-students
 * and the SOM report all need the whole list).
 *
 * `q` now filters **in SQL** using the shared rule. It previously loaded every voucher and filtered in JS on
 * name/nickname only, so the parameter bought nothing — the whole table was read either way, and a parent
 * phone never matched.
 */
// SPEC-028 §7 (TASK-097) — the per-entitlement plan read model: "what does this child have, how do I move
// it?". ONE DTO shape (discriminated by `kind`) the FE renders for both a course and a voucher, so the view
// isn't two code paths. The live end date is DERIVED from the sessions each read, never the stored expiryDate.
const teacherRef = (t: any) => (t ? { id: t.id, name: t.name, nickname: t.nickname } : null);
const subjectRef = (s: any) => (s ? { id: s.id, name: s.name } : null);
const studentRef = (s: any) => (s ? { id: s.id, name: s.name, nickname: s.nickname } : null);
const toSessionRow = (b: any) => ({
  id: b.id,
  date: b.date,
  startTime: b.startTime,
  status: b.status,
  bookingType: b.bookingType, // SPEC-033: lets the course view flag a soft-linked SINGLE_SESSION extra distinctly
  teacher: teacherRef(b.teacher),
  subject: subjectRef(b.subject),
});

export async function getEntitlementPlan(id: string) {
  const loadSessions = (col: "courseId" | "voucherId") =>
    db.query.bookings.findMany({
      where: (b: any, { eq }: any) => eq(b[col], id),
      with: { teacher: true, subject: true },
      orderBy: (b: any, { asc }: any) => [asc(b.date), asc(b.startTime)],
    });

  const course = await db.query.coursePackages.findFirst({
    where: (c, { eq }) => eq(c.id, id),
  });
  if (course) {
    const rows = await loadSessions("courseId");
    const student = course.studentId
      ? await db.query.students.findFirst({ where: (s, { eq }) => eq(s.id, course.studentId!) })
      : null;
    const summary = toCourseSummary(course);
    const planSessions = rows.map((r) => ({
      id: r.id,
      status: r.status,
      date: r.date,
      extendedFromId: r.extendedFromId,
      bookingType: r.bookingType, // SPEC-033: lets courseCurrent/canInsert ignore a soft-linked extra
    }));
    const current = courseCurrent(planSessions);
    return {
      kind: "course" as const,
      id,
      student: studentRef(student),
      sessions: rows.map(toSessionRow), // ALL rows — the extra shows on the course view (SPEC-033 §4)
      // SPEC-033: the derived end is over COURSE_PACKAGE rows only — an extra must not move the plan's end date.
      liveEndDate: deriveLiveEndDate(rows.filter(isCoursePlanRow)), // derived, not the stored expiryDate
      // SPEC-028 §12.1 — the FE disables Insert only when there's genuinely nothing to reschedule (a full course
      // with no appended EXTENDED). `owedCount==0` alone can't tell that from a post-absence course (owed 0 but an
      // EXTENDED present), so the DTO carries the real predicate. The BE still refuses the empty case (NO_OWED_SESSION).
      insertable: canInsert(planSessions, course.size),
      summary: {
        kind: "course" as const,
        size: course.size,
        leaveUsed: summary.leaveUsed,
        leaveQuota: summary.leaveQuota,
        maxWeek: summary.maxWeek,
        owedCount: Math.max(0, course.size - current),
        expiryDate: course.expiryDate, // the MAX_WEEK ceiling, not the live end
      },
    };
  }

  const voucher = await db.query.vouchers.findFirst({ where: (v, { eq }) => eq(v.id, id) });
  if (voucher) {
    const rows = await loadSessions("voucherId");
    const student = voucher.studentId
      ? await db.query.students.findFirst({ where: (s, { eq }) => eq(s.id, voucher.studentId!) })
      : null;
    return {
      kind: "voucher" as const,
      id,
      student: studentRef(student),
      sessions: rows.map(toSessionRow),
      liveEndDate: deriveLiveEndDate(rows),
      insertable: false, // SPEC-028 §12.1 — a voucher has no course-plan insert.
      summary: {
        kind: "voucher" as const,
        totalHours: voucher.totalHours,
        usedHours: voucher.usedHours,
        hoursRemaining: voucher.totalHours - voucher.usedHours,
        expiryDate: voucher.expiryDate,
      },
    };
  }

  throw notFound("ไม่พบคอร์สหรือวอยเชอร์");
}

/**
 * SPEC-035 / TASK-119 (REQ-038 #5) — "ประวัติการตัดคอร์ส". A READ-ONLY timeline reconstructed from existing durable
 * data (no migration): the course's bookings (all statuses) + the freelance-ledger `bo.movement` entries for those
 * bookings. The pure `buildCourseHistory` derives the kinds/ordering/summary; here we just load + map refs.
 */
export async function getCourseHistory(courseId: string) {
  const course = await db.query.coursePackages.findFirst({ where: (c, { eq }) => eq(c.id, courseId) });
  if (!course) throw notFound("ไม่พบคอร์ส");

  const rows = await db.query.bookings.findMany({
    where: (b, { eq }) => eq(b.courseId, courseId),
    with: { teacher: true, subject: true },
    orderBy: (b, { asc }) => [asc(b.date), asc(b.startTime)],
  });

  // The freelance draw/refund ledger for these bookings (refId = bookingId). Empty query guard avoids inArray([]).
  const bookingIds = rows.map((r) => r.id);
  const movements = bookingIds.length
    ? await db.select().from(boMovement).where(inArray(boMovement.refId, bookingIds))
    : [];

  const history = buildCourseHistory(
    { size: course.size, leaveUsed: course.leaveUsed },
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      bookingType: r.bookingType,
      date: r.date,
      extendedFromId: r.extendedFromId,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      teacher: teacherRef(r.teacher),
      subject: subjectRef(r.subject),
    })),
    movements.map((m) => ({
      refId: m.refId,
      refType: m.refType,
      qty: m.qty,
      valueMinor: m.valueMinor,
      createdAt: m.createdAt.toISOString(),
    })),
  );

  return { courseId, ...history };
}

/**
 * SPEC-028 §8 (TASK-095) — teacher availability + clash for ONE slot (purchase-time slot picker). Uses the
 * SAME predicates `insertBooking`/`assertTeacherBookable` enforce (works-that-day, not archived, freelance-set)
 * + the unique-slot rule — read-only for preview, enforced for real at confirm. One definition, not a copy.
 */
export async function getSlotAvailability(date: string, startTime: string) {
  const weekday = weekdayOf(date);
  const teachers = await db.query.teachers.findMany({
    where: (t, { eq }) => eq(t.archived, false),
    orderBy: (t, { asc }) => asc(t.nickname),
  });
  // The clash set is EXACTLY the partial unique index `bookings_teacher_slot_uq` (schema.ts:354): a slot is
  // taken unless the occupant is CANCELLED / PENDING_RESCHEDULE / SICK_LEAVE — a teacher on leave frees the
  // slot for a replacement (UC-004), so a SICK_LEAVE row must NOT read as a clash.
  const booked = await db.query.bookings.findMany({
    where: (b, { and, eq, notInArray }) =>
      and(eq(b.date, date), eq(b.startTime, startTime), notInArray(b.status, [...SLOT_NON_BLOCKING])),
    with: { student: true },
  });
  const clashByTeacher = new Map(booked.map((b: any) => [b.teacherId, b]));

  const out = [];
  for (const t of teachers) {
    if (!teacherWorksOnDay(t.workDays, weekday)) continue; // off that weekday → not a candidate
    const noBudget = await isFreelanceSetupIncomplete(db, t.id, t.type);
    const clash = clashByTeacher.get(t.id);
    out.push({
      teacher: { id: t.id, name: t.name, nickname: t.nickname, type: t.type },
      available: !clash && !noBudget,
      reason: noBudget ? ("NO_BUDGET" as const) : clash ? ("BOOKED" as const) : null,
      clash: clash
        ? { bookingId: clash.id, student: clash.student?.nickname ?? clash.student?.name ?? null }
        : null,
    });
  }
  return { date, startTime, teachers: out };
}

/**
 * SPEC-028 §8 (TASK-095) — the generated `size`-row plan for the purchase modal, WITHOUT writing (AC: editable
 * rows before creation). The FE edits these rows then `POST /courses` with `sessions[]`.
 */
export async function previewCoursePackage(input: {
  teacherId: string;
  subjectId: string;
  size: number;
  startDate: string;
  startTime: string;
  absentWeeks?: number[];
}) {
  if (!isCourseSize(input.size)) throw badRequest("ขนาดคอร์สต้องเป็น 4, 6 หรือ 10");
  const teacher = await db.query.teachers.findFirst({ where: (t, { eq }) => eq(t.id, input.teacherId) });
  const subject = await db.query.subjects.findFirst({ where: (s, { eq }) => eq(s.id, input.subjectId) });
  const absent = new Set(input.absentWeeks ?? []);
  // TASK-148 (AC-1/AC-3): the preview shows the plan the family will actually get — each declared absence is
  // marked and one make-up week is appended for it, so `n sessions · absent d · ends <date>` is readable
  // before saving. Weeks are generated for `size + absences` so the live count still equals `size`.
  const ref = { startTime: input.startTime, teacher: teacherRef(teacher), subject: subjectRef(subject) };
  // The `size` booked weeks are the weekly chain — the save inserts them at exactly these dates (a clash there
  // is refused, not shifted), so the preview shows them as-is.
  const sessions = courseSessionDates(input.startDate, input.size).map((date, i) => ({
    date,
    ...ref,
    absent: absent.has(i + 1),
    makeup: false,
  }));
  // 🔴 TASK-148 rework (Q1(b)): each make-up is placed through the SAME availability-aware logic the save uses
  // (`findFreeExtensionDate`), sequentially, with the dates placed so far treated as occupied. Placing them at
  // naive weekly slots made the previewed **end date** wrong whenever the teacher's slot was taken — and the end
  // date is the preview's headline (AC-1), so a wrong one defeats REQ-045's "create it right the first time".
  const takenByThisPreview = new Set<string>();
  let fromDate = sessions[sessions.length - 1]?.date ?? input.startDate;
  for (let k = 0; k < absent.size; k++) {
    const date = await findFreeExtensionDate(db, input.teacherId, input.startTime, fromDate, takenByThisPreview);
    takenByThisPreview.add(date);
    fromDate = date;
    sessions.push({ date, ...ref, absent: false, makeup: true });
  }
  const live = sessions.filter((s) => !s.absent);
  return {
    size: input.size,
    startDate: input.startDate,
    startTime: input.startTime,
    expiryDate: courseExpiry(input.startDate, input.size), // the MAX_WEEK ceiling
    absentWeeks: [...absent].sort((a, b) => a - b),
    liveCount: live.length,
    endDate: live[live.length - 1]?.date ?? input.startDate,
    // AC-3: the same ceiling the save enforces — the FE can refuse before the user commits.
    exceedsCeiling: sessions.some((s) => exceedsExtensionCeiling(s.date, input.startDate, input.size)),
    sessions,
  };
}

export async function getVouchers(f: { studentId?: string; q?: string } = {}) {
  return vouchersByIds(await voucherIdsOrdered(f));
}

/** The `/vouchers` tab: same rows and order, plus paging. */
export async function listVouchersPaged(f: {
  studentId?: string;
  q?: string;
  page: number;
  limit: number;
}) {
  const [ids, [{ value: total }]] = await Promise.all([
    voucherIdsOrdered(f),
    voucherCountQuery(f),
  ]);
  return { items: await vouchersByIds(ids), page: f.page, limit: f.limit, total };
}

// Issue a voucher (5/10/15h). Validity starts at the first booking (B.5); a
// provisional expiry from today keeps the NOT NULL column valid until then.
export async function createVoucher(input: any) {
  if (!isVoucherHours(input.totalHours))
    throw badRequest("จำนวนชั่วโมงวอยเชอร์ต้องเป็น 5, 10 หรือ 15");
  // TASK-160: validated before the voucher row exists — an invalid discount refuses the sale outright.
  const discount = validateSaleDiscount(
    input.discount,
    listPriceMinor(voucherItemRef(input.totalHours)) ?? 0,
    input.actor ?? null,
  );
  const result = await db.transaction(async (tx) => {
    const studentId = await resolveStudentId(tx, input.student);
    // TASK-058: a suspended household may not BUY. Inside the tx and BEFORE the insert, so the blocked sale
    // never reaches the `recordSale(...)` revenue post below.
    await assertHouseholdNotSuspended(tx, studentId);
    const [v] = await tx
      .insert(vouchers)
      .values({
        studentId,
        totalHours: input.totalHours,
        expiryDate: voucherExpiry(input.totalHours, fmtDate(new Date())),
      })
      .returning({ id: vouchers.id });
    const row = await tx.query.vouchers.findFirst({
      where: (x, { eq }) => eq(x.id, v.id),
      with: { student: true },
    });
    return { voucher: toVoucherDTO(row) };
  });

  // Phase 2: a voucher sale → record revenue on its INCOME item ("voucher-{hours}").
  void recordSale(voucherItemRef(input.totalHours), 1, {
    refId: result.voucher.id,
    idempotencyKey: `voucher-sale:${result.voucher.id}`,
    discount, // TASK-160 — validated before the voucher was written
  });

  return result;
}

// ───────────────────────── Overbooking a leave slot (UC-004) ─────────────────────────
// Staff may only overbook a slot whose occupant is on leave (SICK_LEAVE) — that
// student is not attending and is already auto-extended, so no move/parent-confirm
// flow is needed (the old B.1 reschedule flow was removed per UC-006). The DB unique
// slot index excludes SICK_LEAVE, so a plain `createBooking` inserts the replacement
// into the freed slot; overbooking an *active* slot still 409s (SLOT_TAKEN).

async function findFreeExtensionDate(
  exec: any,
  teacherId: string,
  startTime: string,
  fromDate: string,
  // TASK-148 rework: dates already claimed by THIS run but not yet in the DB. The save doesn't need it (each
  // insert is visible to the next query inside the tx); the preview does, because it writes nothing — without
  // it two absences would both be placed in the same free week and the previewed end date would be too early.
  alreadyTaken: ReadonlySet<string> = new Set(),
) {
  return firstFreeWeeklySlot(fromDate, async (d) => {
    if (alreadyTaken.has(d)) return true;
    return !!(await exec.query.bookings.findFirst({
      where: (b: any, { and, eq, ne }: any) =>
        and(eq(b.teacherId, teacherId), eq(b.date, d), eq(b.startTime, startTime), ne(b.status, "CANCELLED")),
    }));
  });
}

/**
 * SPEC-028 / TASK-092 — apply the pure `planCourseMoves` to a course's bookings in the passed tx: cancel
 * the trailing appended `EXTENDED` sessions (long) and/or append make-ups after the last live date (short),
 * bringing the course back to its `size`-target. Returns the moves for the caller to log. The applier mirrors
 * TASK-091's `reconcileBookingHolds` (pure planner + tx applier); TASK-093's `applyPlanChange` gates the rules.
 */
export async function reconcileCoursePlan(tx: any, courseId: string) {
  const course = await tx.query.coursePackages.findFirst({
    where: (c: any, { eq }: any) => eq(c.id, courseId),
  });
  if (!course) throw notFound("ไม่พบคอร์ส");

  // SPEC-033 §2 seam-keeper: the course engine loads ONLY COURSE_PACKAGE rows — a soft-linked SINGLE_SESSION extra
  // shares the courseId but must not be seen here (so it doesn't count toward size, and its cancel — which TASK-105
  // routes through this fn — never re-owes a makeup).
  const rows = await tx.query.bookings.findMany({
    where: (b: any, { and, eq }: any) => and(eq(b.courseId, courseId), eq(b.bookingType, "COURSE_PACKAGE")),
  });

  const plan = planCourseMoves(
    rows.map(
      (r: any): PlanSession => ({
        id: r.id,
        status: r.status,
        date: r.date,
        extendedFromId: r.extendedFromId,
        bookingType: r.bookingType,
      }),
    ),
    course.size,
  );

  const cancelled: string[] = [];
  for (const id of plan.cancelIds) {
    await tx
      .update(bookings)
      .set({ status: "CANCELLED", note: "ยกเลิกคาบขยายอัตโนมัติ (ปรับแผนคอร์ส)" })
      .where(eq(bookings.id, id));
    cancelled.push(id);
  }

  const appended: string[] = [];
  if (plan.append.length) {
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    const cancelledSet = new Set(plan.cancelIds);
    const liveAfterCancel = rows.filter(
      (r: any) => COURSE_LIVE.has(r.status) && !cancelledSet.has(r.id),
    );
    // Append after the last still-live session date (fall back to the course start).
    let fromDate: string = liveAfterCancel.reduce(
      (m: string, r: any) => (r.date > m ? r.date : m),
      course.startDate,
    );
    for (const a of plan.append) {
      // Mirror the makeup's teacher/subject/time from the absence it replaces (or a live session).
      const template = (a.extendedFromId ? byId.get(a.extendedFromId) : null) ?? liveAfterCancel[0] ?? rows[0];
      if (!template) break;
      const extDate = await findFreeExtensionDate(tx, template.teacherId, template.startTime, fromDate);
      // SPEC-028 §5 #2 (TASK-093): the extension is HARD-bounded by the course's MAX_WEEK ceiling.
      if (exceedsExtensionCeiling(extDate, course.startDate, course.size)) {
        throw conflict(
          "EXTENSION_CEILING",
          `คอร์สขยายเกินสัปดาห์ที่ ${MAX_WEEK_BY_SIZE[course.size] ?? "?"} ไม่ได้`,
        );
      }
      const [ext] = await tx
        .insert(bookings)
        .values({
          studentId: template.studentId,
          teacherId: template.teacherId,
          subjectId: template.subjectId,
          date: extDate,
          startTime: template.startTime,
          endTime: template.endTime,
          bookingType: "COURSE_PACKAGE",
          status: "EXTENDED",
          courseId,
          extendedFromId: a.extendedFromId,
          note: "คาบขยายอัตโนมัติจากการปรับแผนคอร์ส",
        })
        .returning({ id: bookings.id });
      appended.push(ext.id);
      fromDate = extDate;
    }
  }

  return { appended, cancelled };
}

export type PlanChange =
  | { kind: "mark-absence"; bookingId: string; planned: boolean; reason?: string; override?: boolean }
  | { kind: "insert"; teacherId: string; subjectId: string; date: string; startTime: string }
  | {
      kind: "move";
      bookingId: string;
      teacherId?: string;
      subjectId?: string;
      date?: string;
      startTime?: string;
      override?: boolean;
    };

// SPEC-028 §12.2 — thrown to abort the tx in `dryRun` mode: the change is fully applied inside the transaction,
// its result captured, then this rolls everything back. Carries the preview so the outer catch can return it.
class DryRunSignal {
  constructor(public result: unknown) {}
}

/** Read back a course's resulting plan (after the in-tx apply) for the dry-run preview — same shape a real read gives. */
async function planPreviewResult(tx: any, courseId: string, applied: any) {
  const rows = await tx.query.bookings.findMany({
    where: (b: any, { eq }: any) => eq(b.courseId, courseId),
    with: { teacher: true, subject: true },
    orderBy: (b: any, { asc }: any) => [asc(b.date), asc(b.startTime)],
  });
  return {
    change: applied.change,
    moves: { appended: applied.appended ?? [], cancelled: applied.cancelled ?? [] },
    resultingSessions: rows.map(toSessionRow),
    liveEndDate: deriveLiveEndDate(rows.filter(isCoursePlanRow)), // SPEC-033: end over COURSE_PACKAGE rows only
  };
}

/**
 * SPEC-028 §3 (TASK-093) — the ONE shared, ATOMIC plan-edit applier (calendar / course screen / purchase-time
 * all call it, so the rule has a single implementation). Opens a tx, applies the booking mutation, runs the
 * `size`-reconcile (TASK-092) + the freelance-hold reconcile (TASK-091), and commits or rolls back with a
 * typed reason. All validation is inside the tx: any failure ⇒ **nothing written** (a half-applied plan is
 * worse than a rejected one).
 *
 * `opts.dryRun` (SPEC-028 §12.2 / TASK-114) runs the **full** transaction — every guard + both reconciles — then
 * reads back the resulting plan and ROLLS BACK instead of committing, returning `{ change, moves, resultingSessions,
 * liveEndDate }`. Reusing the real applier is the point: preview can never diverge from apply. A refused change
 * throws the **same typed reason** in dry-run as in a real apply.
 */
export async function applyPlanChange(
  courseId: string,
  change: PlanChange,
  opts: { dryRun?: boolean } = {},
) {
  try {
    return await db.transaction(async (tx) => {
      const course = await tx.query.coursePackages.findFirst({
        where: (c: any, { eq }: any) => eq(c.id, courseId),
      });
      if (!course) throw notFound("ไม่พบคอร์ส");

      // In dry-run, capture the applied result + resulting plan, then roll the whole tx back (nothing is written).
      const finalize = async (applied: any) => {
        if (opts.dryRun) throw new DryRunSignal(await planPreviewResult(tx, courseId, applied));
        return applied;
      };

      if (change.kind === "mark-absence") {
        const b = await tx.query.bookings.findFirst({
          where: (x: any, { eq }: any) => eq(x.id, change.bookingId),
        });
        if (!b || b.courseId !== courseId) throw notFound("ไม่พบคาบในคอร์สนี้");
        if (isDelivered(b.status)) throw conflict("SESSION_DELIVERED", "คาบที่เรียนไปแล้ว แก้ไขไม่ได้");
        if (!change.override) {
          const teacher = await tx.query.teachers.findFirst({
            where: (t: any, { eq }: any) => eq(t.id, b.teacherId),
          });
          if (teacher) {
            // SPEC-048 (TASK-146): the cut-off is a setting now — resolved at action time, inside this tx and
            // inside the `!override` guard, so an admin cancel stays exempt (AC-5).
            const { value: cutoffHours } = await getSetting(leaveCutoffKey(teacher.type), tx);
            if (!hasEnoughLeaveNotice(b.date, b.startTime, cutoffHours))
              throw conflict("LEAVE_NOTICE_TOO_LATE", leaveNoticeMessage(cutoffHours, b.startTime));
          }
        }
        // A plain sick-leave over quota stays LOCKED (needs adminUnlocked / override); a PLANNED absence
        // bypasses the soft lock but is still MAX_WEEK-bound (enforced inside reconcileCoursePlan). SPEC §6.
        if (!change.planned && !change.override && toCourseSummary(course).leaveLocked) {
          throw conflict("LEAVE_LOCKED", "โควตาการลาเต็มแล้ว — ต้องปลดล็อกโดยแอดมินก่อน");
        }
        await tx
          .update(bookings)
          .set({ status: "SICK_LEAVE", note: change.reason ?? b.note })
          .where(eq(bookings.id, b.id));
        // TASK-148 (REQ-045 B): an absence DECLARED AT CREATION is free, so re-marking such a row must not
        // start charging quota for it. Every other mark-absence — including a later planned one — consumes.
        if (!b.plannedAtCreation) {
          await tx
            .update(coursePackages)
            .set({ leaveUsed: course.leaveUsed + 1 })
            .where(eq(coursePackages.id, courseId));
        }
        const moves = await reconcileCoursePlan(tx, courseId); // appends the makeup (MAX_WEEK enforced)
        await reconcileBookingHolds(tx, b.id, b.teacherId, "SICK_LEAVE", change.override ?? false);
        return await finalize({ change: "mark-absence" as const, ...moves });
      }

      if (change.kind === "insert") {
        const rows = await tx.query.bookings.findMany({
          where: (x: any, { eq }: any) => eq(x.courseId, courseId),
        });
        if (
          !canInsert(
            rows.map((r: any) => ({
              id: r.id,
              status: r.status,
              date: r.date,
              extendedFromId: r.extendedFromId,
              bookingType: r.bookingType, // SPEC-033: a soft-linked extra must not read as an owed session
            })),
            course.size,
          )
        ) {
          throw conflict("NO_OWED_SESSION", "คอร์สนี้ครบจำนวนคาบแล้ว — ไม่มีคาบค้างให้เลื่อน");
        }
        const studentId = rows[0]?.studentId;
        if (!studentId) throw badRequest("คอร์สนี้ยังไม่มีคาบเรียน");
        // insertBooking runs the availability gate + slot-clash; the reconcile then cancels the newest
        // appended EXTENDED to net-zero (an insert that satisfies a previously-appended gap).
        const newId = await insertBooking(tx, studentId, {
          teacherId: change.teacherId,
          subjectId: change.subjectId,
          date: change.date,
          startTime: change.startTime,
          bookingType: "COURSE_PACKAGE",
          courseId,
        });
        const moves = await reconcileCoursePlan(tx, courseId);
        return await finalize({ change: "insert" as const, bookingId: newId, ...moves });
      }

      // move / change-teacher / change-day-time — no size change, so no course reconcile; money reconciles.
      const b = await tx.query.bookings.findFirst({
        where: (x: any, { eq }: any) => eq(x.id, change.bookingId),
      });
      if (!b || b.courseId !== courseId) throw notFound("ไม่พบคาบในคอร์สนี้");
      if (isDelivered(b.status)) throw conflict("SESSION_DELIVERED", "คาบที่เรียนไปแล้ว แก้ไขไม่ได้");
      // SPEC-042 (TASK-134): this branch is by definition a course session (`b.courseId === courseId`),
      // and a course's program is fixed at creation — refuse a subject change, allow a no-op.
      if (changesCourseSubject(b, change.subjectId)) {
        throw conflict(COURSE_SUBJECT_LOCKED, COURSE_SUBJECT_LOCKED_MESSAGE);
      }
      const patch: any = {};
      if (change.teacherId) patch.teacherId = change.teacherId;
      if (change.subjectId) patch.subjectId = change.subjectId;
      if (change.date) patch.date = change.date;
      if (change.startTime) {
        patch.startTime = change.startTime;
        patch.endTime = addHour(change.startTime);
      }
      const newTeacherId = patch.teacherId ?? b.teacherId;
      // TASK-094 (SPEC-028 §5 #3): a teacher swap must be ≥3 days before the class the new teacher inherits, so
      // they get warning. Admin `override` bypasses (REQ-031 will make the day count editable — the lib stays
      // pure). Only the notice/notify fire on an ACTUAL change of teacher; a date/subject-only edit is untouched.
      const teacherChanged = change.teacherId !== undefined && change.teacherId !== b.teacherId;
      const noticeDate = patch.date ?? b.date;
      const noticeTime = patch.startTime ?? b.startTime;
      if (teacherChanged && !(change.override ?? false)) {
        // SPEC-029: the notice threshold is a configurable rule — resolve at action time (default 3), pass in.
        const { value: noticeDays } = await getSetting("teacher_change_notice_days", tx);
        if (!hasEnoughTeacherChangeNotice(noticeDate, noticeTime, bangkokNow(), noticeDays)) {
          throw conflict("TEACHER_CHANGE_TOO_LATE", teacherChangeNoticeMessage(noticeDays));
        }
      }
      await assertTeacherBookable(tx, newTeacherId, patch.date ?? b.date);
      await tx.update(bookings).set(patch).where(eq(bookings.id, b.id));
      await reconcileBookingHolds(tx, b.id, newTeacherId, b.status, change.override ?? false);
      // Notify BOTH sides of the swap: the old teacher (off your schedule) + the new teacher (now yours).
      if (teacherChanged) {
        const [oldTeacher, newTeacher] = await Promise.all([
          tx.query.teachers.findFirst({ where: (t: any, { eq }: any) => eq(t.id, b.teacherId) }),
          tx.query.teachers.findFirst({ where: (t: any, { eq }: any) => eq(t.id, newTeacherId) }),
        ]);
        await enqueueLine(
          {
            recipientType: "teacher",
            recipientLineUserId: oldTeacher?.lineUserId ?? null,
            bookingId: b.id,
            payload: { kind: "teacher_unassigned", bookingId: b.id },
          },
          tx,
        );
        await enqueueLine(
          {
            recipientType: "teacher",
            recipientLineUserId: newTeacher?.lineUserId ?? null,
            bookingId: b.id,
            payload: { kind: "teacher_assigned", bookingId: b.id },
          },
          tx,
        );
      }
      return await finalize({ change: "move" as const, bookingId: b.id });
    });
  } catch (e: any) {
    if (e instanceof DryRunSignal) return e.result; // §12.2 — the intended rollback; return the captured preview.
    const code = pgErrorCode(e);
    if (code === "23505") throw conflict("SLOT_TAKEN", "ครูมีคาบในช่วงเวลานี้แล้ว");
    if (code === "23503") throw badRequest("teacher / subject อ้างอิงไม่ถูกต้อง");
    throw e;
  }
}

export async function updateBookingStatus(
  id: string,
  action: string,
  reason?: string,
  override = false,
) {
  const result = await db.transaction(async (tx) => {
    const current = await tx.query.bookings.findFirst({
      where: (b, { eq }) => eq(b.id, id),
      with: { course: true, voucher: true },
    });
    if (!current) throw notFound("ไม่พบคาบเรียน");

    let extendedId: string | null = null;
    let locked = false;
    let notification: NotifyResult | null = null;

    if (action === "confirm") {
      if (current.confirmedAt) {
        notification = { channel: "line", status: "skipped", reason: "คาบนี้ยืนยันแล้ว" };
      } else {
        await tx
          .update(bookings)
          .set({ status: "CONFIRMED", confirmedAt: new Date() })
          .where(eq(bookings.id, id));
        const teacher = await tx.query.teachers.findFirst({
          where: (t, { eq }) => eq(t.id, current.teacherId),
        });
        notification = await enqueueLine(
          {
            recipientType: "teacher",
            recipientLineUserId: teacher?.lineUserId ?? null,
            bookingId: id,
            payload: { kind: "booking_confirmed", bookingId: id },
          },
          tx,
        );
        await issueCheckinToken(id, tx);
      }
    } else if (action === "attend") {
      if (current.status !== "ATTENDED") {
        await tx.update(bookings).set({ status: "ATTENDED" }).where(eq(bookings.id, id));
        if (current.courseId && current.course) {
          await tx
            .update(coursePackages)
            .set({ usedSessions: current.course.usedSessions + 1 })
            .where(eq(coursePackages.id, current.courseId));
        }
        // Voucher hour deduction on real attendance (B.5).
        if (current.voucherId && current.voucher) {
          await tx
            .update(vouchers)
            .set({ usedHours: current.voucher.usedHours + 1 })
            .where(eq(vouchers.id, current.voucherId));
        }
      }
    } else if (action === "cancel") {
      // SPEC-028 §11.2 (TASK-105, relaxes TASK-093) — cancelling a DELIVERED session (attended/no-show) is now
      // allowed to undo a mis-marked attendance, but ONLY with a non-empty reason, audited into `note`. Edit/move
      // of a delivered session stays blocked (that guard lives in moveBooking / applyPlanChange).
      const cancelReason = reason?.trim();
      if (requiresCancelReason(current.status) && !cancelReason) {
        throw conflict("REASON_REQUIRED", "ต้องระบุเหตุผลในการยกเลิกคาบที่เรียนไปแล้ว");
      }
      await tx
        .update(bookings)
        .set({ status: "CANCELLED", note: cancelReason ?? current.note })
        .where(eq(bookings.id, id));
      // SPEC-043 / TASK-144 (REQ-050 Gap-C) — correcting a mis-marked check-in must RETURN the unit it consumed.
      // `attend` is the only writer that increments these counters; this is the only one that gives back. It runs
      // in the same transaction as the status change and the freelance reconcile, so the correction is atomic.
      if (returnsConsumedUnit(current.status)) {
        if (current.courseId && current.course) {
          await tx
            .update(coursePackages)
            .set({ usedSessions: afterReturn(current.course.usedSessions) })
            .where(eq(coursePackages.id, current.courseId));
        }
        if (current.voucherId && current.voucher) {
          // A voucher has no make-up to re-owe — without this the family's hour is simply gone.
          await tx
            .update(vouchers)
            .set({ usedHours: afterReturn(current.voucher.usedHours) })
            .where(eq(vouchers.id, current.voucherId));
        }
      }
      // SPEC-028 §11.3 — EVERY course-session cancel is a reschedule, not a forfeit: re-owe a makeup so `current`
      // returns to `size` (only NO_SHOW consumes, and that's the no-show action, not this path). Was NOT wired into
      // cancel before TASK-105. The money hold releases below (CANCELLED is releasing); the makeup draws on its
      // own confirm — so a cancel nets zero freelance hours until the makeup is taught.
      if (current.courseId) {
        try {
          await reconcileCoursePlan(tx, current.courseId);
        } catch (e) {
          // TASK-105 follow-up: on a cancel, the re-owe makeup can't fit within MAX_WEEK → reconcileCoursePlan
          // throws EXTENSION_CEILING, whose "course extends past week N" wording is confusing on a CANCEL. Re-map to
          // a cancel-specific reason (the extend paths keep the generic message). Fix rides REQ-036 (early termination).
          if (e instanceof ApiException && e.code === "EXTENSION_CEILING") {
            throw conflict(
              "CANCEL_AT_CEILING",
              "ยกเลิกคาบนี้ไม่ได้: คอร์สเต็มกำหนดสัปดาห์สูงสุดแล้ว คาบชดเชยจึงไม่มีที่ลง — ใช้สิทธิ์แอดมิน (override) หรือจัดการแบบสิ้นสุดคอร์สก่อนกำหนด",
            );
          }
          throw e;
        }
      }
    } else if (action === "sick-leave" && current.status === "SICK_LEAVE") {
      // SPEC-044 / TASK-136 AC-6 — a re-save (or a retry) of an already-cancelled session changes nothing and
      // must NOT enqueue a second notification. Mirrors the confirm (`confirmedAt`) and attend guards; it also
      // fixes the pre-existing admin double-notify. The tail reconcile below is idempotent by design.
      notification = { channel: "line", status: "skipped", reason: "คาบนี้แจ้งลาแล้ว" };
    } else if (action === "sick-leave") {
      // Advance-notice rule (UC-029 + SPEC-048/TASK-146): leave must be requested early enough for the
      // session's teacher type — now an editable setting (default 3h both), not a hard-coded 60/120 minutes.
      // Admin may override for special cases, and the setting is not even read on that path (AC-5).
      if (!override) {
        const teacher = await tx.query.teachers.findFirst({
          where: (t, { eq }) => eq(t.id, current.teacherId),
        });
        if (teacher) {
          const { value: cutoffHours } = await getSetting(leaveCutoffKey(teacher.type), tx);
          if (!hasEnoughLeaveNotice(current.date, current.startTime, cutoffHours)) {
            throw conflict("LEAVE_NOTICE_TOO_LATE", leaveNoticeMessage(cutoffHours, current.startTime));
          }
        }
      }

      await tx
        .update(bookings)
        .set({ status: "SICK_LEAVE", note: reason ?? current.note })
        .where(eq(bookings.id, id));

      if (current.courseId && current.course) {
        if (canTakeLeave(current.course)) {
          // TASK-148 (REQ-045 B): a row born `plannedAtCreation` is a free absence — taking leave on it again
          // must not start charging quota. A normal sick leave (the overwhelming case) is unaffected.
          if (!current.plannedAtCreation) {
            await tx
              .update(coursePackages)
              .set({ leaveUsed: current.course.leaveUsed + 1 })
              .where(eq(coursePackages.id, current.courseId));
          }

          const latest = await tx.query.bookings.findMany({
            where: (b, { and, eq, ne }) =>
              and(eq(b.courseId, current.courseId!), ne(b.status, "CANCELLED")),
            orderBy: (b, { desc }) => desc(b.date),
            limit: 1,
          });
          const lastDate = latest[0]?.date ?? current.date;
          const extDate = await findFreeExtensionDate(
            tx,
            current.teacherId,
            current.startTime,
            lastDate,
          );

          const [ext] = await tx
            .insert(bookings)
            .values({
              studentId: current.studentId,
              teacherId: current.teacherId,
              subjectId: current.subjectId,
              date: extDate,
              startTime: current.startTime,
              endTime: current.endTime,
              bookingType: "COURSE_PACKAGE",
              status: "EXTENDED",
              courseId: current.courseId,
              extendedFromId: id,
              note: "คาบขยายอัตโนมัติจากการลา",
            })
            .returning({ id: bookings.id });
          extendedId = ext.id;
        } else {
          locked = true; // over quota — needs admin unlock
        }
      }
      await awardCrmPoints(current.studentId, CRM_POINT_RULES.PROPER_SICK_LEAVE, tx);
      const student = await tx.query.students.findFirst({
        where: (s: any, { eq: e }: any) => e(s.id, current.studentId),
      });
      const via = reason?.includes("LINE") ? "line" : "staff";
      await notifyAdmins(
        {
          kind: "sick_leave",
          bookingId: id,
          studentName: student?.name ?? "",
          via,
        },
        tx,
        id, // TASK-136: the outbox row now carries the booking, so the worker can enrich date/teacher/program
      );
      // SPEC-044 / TASK-136 (AC-1/AC-2/AC-3): the teacher of THIS session is told the slot is free — but only
      // when the school has opted in. Default `admin_only` ⇒ nothing here fires, so no coach is messaged by an
      // upgrade. Additive and non-throwing: `enqueueLine` writes a SKIPPED row when the teacher has no LINE
      // link (AC-4), so a leave never fails because of a notification.
      const { value: notifyOnLeave } = await getSetting("notify_on_leave", tx);
      if (notifyOnLeave === "admin_and_teacher") {
        const leaveTeacher = await tx.query.teachers.findFirst({
          where: (t, { eq }) => eq(t.id, current.teacherId),
        });
        await enqueueLine(
          {
            recipientType: "teacher",
            recipientLineUserId: leaveTeacher?.lineUserId ?? null,
            bookingId: id,
            payload: { kind: "leave_teacher", bookingId: id, studentName: student?.name ?? "", via },
          },
          tx,
        );
      }
    } else {
      throw badRequest(`action ไม่รองรับ: ${action}`);
    }

    // REQ-006 (TASK-028): reconcile the freelance ceiling drawdown to the booking's *actual* new status —
    // one idempotent movement, `held` derived from the ledger. Replaces the old draw-on-confirm /
    // refund-on-cancel-or-leave, which mutated `remaining` unconditionally and double-refunded on a status
    // round-trip (ATTENDED↔SICK_LEAVE) → `remaining` past ceiling. Consuming (holds the draw): CONFIRMED /
    // ATTENDED / EXTENDED; releasing: SICK_LEAVE / NO_SHOW / CANCELLED / PENDING (SICK_LEAVE now RELEASES —
    // owner reversal TASK-104). The makeup EXTENDED row is deliberately NOT reconciled here — it draws on its
    // own confirm, so a sick-leave costs one freelance hour total (the makeup), not two.
    const after = await tx.query.bookings.findFirst({ where: (b, { eq }) => eq(b.id, id) });
    if (after) await reconcileBookingHolds(tx, id, current.teacherId, after.status, override);

    const booking = await loadBookingDTO(tx, id);
    const extended = extendedId ? await loadBookingDTO(tx, extendedId) : null;
    return { booking, extended, course: booking.course, locked, notification };
  });

  return result;
}

/**
 * Confirm many PENDING bookings in one call (REQ-008 / TASK-036). Each id reuses the single
 * `updateBookingStatus(id,"confirm")` — its **own** transaction, idempotency, LINE outbox and freelance draw —
 * so one failure never rolls back the others (partial success). A non-PENDING id is classified without a write
 * (never un-cancels). Results are returned in input order.
 */
export async function bulkConfirm(ids: string[]): Promise<{ results: BulkConfirmResult[] }> {
  const results: BulkConfirmResult[] = [];
  for (const id of ids) {
    const booking = await db.query.bookings.findFirst({ where: (b, { eq }) => eq(b.id, id) });
    const pre = preCheckBulkConfirm(booking);
    if (!pre.proceed) {
      results.push({ id, outcome: pre.outcome, reason: pre.reason });
      continue;
    }
    try {
      await updateBookingStatus(id, "confirm"); // no override — REQ-007 removed override-to-book
      results.push({ id, outcome: "confirmed" });
    } catch (err) {
      // INSUFFICIENT_BUDGET (over-budget freelance) or any ApiException → skip this one, keep going.
      results.push({
        id,
        outcome: "skipped",
        reason: err instanceof Error ? err.message : "ยืนยันคาบไม่สำเร็จ",
      });
    }
  }
  return { results };
}

export async function moveBooking(
  id: string,
  input: { teacherId?: string; subjectId?: string; date?: string; startTime?: string; note?: string },
) {
  const current = await db.query.bookings.findFirst({ where: (b, { eq }) => eq(b.id, id) });
  if (!current) throw notFound("ไม่พบคาบเรียน");
  // SPEC-028 §5 (TASK-093) — a delivered session (attended / no-show) is immutable.
  if (isDelivered(current.status)) throw conflict("SESSION_DELIVERED", "คาบที่เรียนไปแล้ว แก้ไขไม่ได้");
  // SPEC-042 (TASK-134): course sessions only (`courseId != null`) — voucher / single / trial may still
  // change subject. A no-op (same subjectId) passes.
  if (changesCourseSubject(current, input.subjectId)) {
    throw conflict(COURSE_SUBJECT_LOCKED, COURSE_SUBJECT_LOCKED_MESSAGE);
  }

  const patch: any = {};
  if (input.teacherId) patch.teacherId = input.teacherId;
  if (input.subjectId) patch.subjectId = input.subjectId;
  if (input.date) patch.date = input.date;
  if (input.startTime) {
    patch.startTime = input.startTime;
    patch.endTime = addHour(input.startTime); // re-derive end on a time change
  }
  if (input.note !== undefined) patch.note = input.note;

  try {
    // 🔴 TASK-091 — the teacher write and the money move must be ONE transaction, or a failure between them
    // leaves the assignment and the ceiling disagreeing about who is teaching (and being paid for) the hour.
    await db.transaction(async (tx) => {
      // SPEC-028 §5 (TASK-093) — the availability re-check `insertBooking` does, which `moveBooking` skipped:
      // a teacher/date edit can't land a teacher on a day off / archived / with no freelance budget set.
      await assertTeacherBookable(
        tx,
        patch.teacherId ?? current.teacherId,
        patch.date ?? current.date,
      );
      await tx.update(bookings).set(patch).where(eq(bookings.id, id));
      // Reconcile whole-booking against the CURRENT teacher — `patch.teacherId` if it moved, else the one it
      // already had. Releases any item still holding this booking for a teacher who no longer teaches it, and
      // draws the new one. A move with no teacher change produces no adjustments, so date/time-only edits are
      // unchanged. `current.status` is used because a move never changes status.
      await reconcileBookingHolds(tx, id, patch.teacherId ?? current.teacherId, current.status, false);
    });
  } catch (e: any) {
    const code = pgErrorCode(e);
    if (code === "23505") throw conflict("SLOT_TAKEN", "ครูมีคาบในช่วงเวลานี้แล้ว");
    if (code === "23503") throw badRequest("teacher / subject อ้างอิงไม่ถูกต้อง");
    throw e;
  }
  return { booking: await loadBookingDTO(db, id) };
}

export async function setAvailability(input: {
  teacherId?: string;
  type?: any;
  active: boolean;
}) {
  if (input.teacherId) {
    await db.update(teachers).set({ active: input.active }).where(eq(teachers.id, input.teacherId));
  } else {
    await db.update(teachers).set({ active: input.active }).where(eq(teachers.type, input.type));
  }
  const rows = await db.query.teachers.findMany({
    where: input.teacherId
      ? (t, { eq }) => eq(t.id, input.teacherId!)
      : (t, { eq }) => eq(t.type, input.type),
    with: { teacherSubjects: { with: { subject: true } } },
  });
  return { teachers: rows.map(toTeacherDTO) };
}

/**
 * TASK-100 (SPEC-028 §7.5) — the ORPHAN IMPACT of a proposed `workDays` change, WITHOUT applying it. A workDays
 * change is the one path that can still strand a future session (archiving is already hard-guarded), and a hard
 * block there is wrong — a genuine availability change mustn't trap the admin. So this feeds a soft FE confirm:
 * how many future LIVE sessions fall on a weekday the teacher would stop working. TASK-096 is the after-the-fact net.
 */
export async function previewWorkDaysChange(id: string, nextWorkDays: number[]) {
  const teacher = await db.query.teachers.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!teacher) throw notFound("ไม่พบครู");

  const removed = removedWorkDays(teacher.workDays, nextWorkDays);
  if (!removed.length) {
    return { removedDays: [], removedDaysLabel: "", orphanCount: 0, sessions: [] };
  }

  // Future LIVE sessions only — a delivered/cancelled session can't be orphaned.
  const today = bangkokNow().date;
  const rows = await db.query.bookings.findMany({
    where: (b, { and, eq, gte, inArray }) =>
      and(eq(b.teacherId, id), gte(b.date, today), inArray(b.status, [...COURSE_LIVE_STATUSES])),
    with: { student: true, subject: true, teacher: true },
    orderBy: (b, { asc }) => [asc(b.date), asc(b.startTime)],
  });

  const withWeekday = rows.map((b) => ({ ...toSessionRow(b), weekday: weekdayOf(b.date), student: studentRef(b.student) }));
  const orphaned = sessionsOnRemovedDays(withWeekday, removed);
  return {
    removedDays: removed,
    removedDaysLabel: formatWorkDaysLabel(removed),
    orphanCount: orphaned.length,
    sessions: orphaned,
  };
}

export async function setTeacherWorkDays(id: string, workDays: number[]) {
  const sorted = [...new Set(workDays)].sort((a, b) => a - b);
  const [row] = await db
    .update(teachers)
    .set({ workDays: sorted })
    .where(eq(teachers.id, id))
    .returning();
  if (!row) throw notFound("ไม่พบครู");
  const full = await db.query.teachers.findFirst({
    where: (t, { eq }) => eq(t.id, id),
    with: { teacherSubjects: { with: { subject: true } } },
  });
  return toTeacherDTO(full);
}

// TASK-008: persist the admin over-budget override for a freelance teacher (app_settings).
// Read by the booking-commit path (drawFreelanceBudget allowNegative) and surfaced on the DTO.
export async function setLimitOverride(id: string, override: boolean) {
  const teacher = await db.query.teachers.findFirst({
    where: (t, { eq }) => eq(t.id, id),
    with: { teacherSubjects: { with: { subject: true } } },
  });
  if (!teacher) throw notFound("ไม่พบครู");
  await db
    .insert(appSettings)
    .values({ key: `${LIMIT_OVERRIDE_PREFIX}${id}`, value: override })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: override } });
  const dto = toTeacherDTO(teacher);
  dto.limitOverride = override;
  return dto;
}

// ───────────────────── Teacher lifecycle (SPEC-004 / TASK-016) ─────────────────────

/** Load one teacher fully-decorated (rate/budget, setupIncomplete, override) — the DTO shape the
 *  lifecycle mutations return. */
async function loadTeacherFull(id: string) {
  const row = await db.query.teachers.findFirst({
    where: (t, { eq }) => eq(t.id, id),
    with: { teacherSubjects: { with: { subject: true } } },
  });
  if (!row) throw notFound("ไม่พบครู");
  const [dto] = await attachFreelanceBudgets([toTeacherDTO(row)]);
  dto.limitOverride = await readLimitOverride(db, id);
  return dto;
}

/** Create a teacher (standalone — TASK-029). Freelance money is a local `bo.item` (set later via the
 *  admin UI), so there is no backoffice party to sync; the tx just inserts the teacher + its subjects. */
export async function createTeacher(input: {
  name: string;
  nickname: string;
  type: TeacherType;
  workDays?: number[];
  subjectIds?: string[];
}) {
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(teachers)
      .values({
        name: input.name,
        nickname: input.nickname,
        type: input.type,
        workDays: input.workDays
          ? [...new Set(input.workDays)].sort((a, b) => a - b)
          : undefined,
      })
      .returning({ id: teachers.id });
    if (input.subjectIds?.length) {
      await tx
        .insert(teacherSubjects)
        .values(input.subjectIds.map((subjectId) => ({ teacherId: row.id, subjectId })));
    }
    return row.id;
  });
  return loadTeacherFull(id);
}

/** Edit a teacher (standalone — TASK-029). Updates name/nickname/type/subjects locally; type change is
 *  effective-dated only in the (deferred) backoffice salary model, so there is no money mutation here. */
export async function updateTeacher(
  id: string,
  input: { name?: string; nickname?: string; type?: TeacherType; subjectIds?: string[] },
) {
  const current = await db.query.teachers.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!current) throw notFound("ไม่พบครู");

  await db.transaction(async (tx) => {
    const set: Partial<typeof teachers.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.nickname !== undefined) set.nickname = input.nickname;
    if (input.type !== undefined) set.type = input.type;
    if (Object.keys(set).length) await tx.update(teachers).set(set).where(eq(teachers.id, id));

    if (input.subjectIds) {
      await tx.delete(teacherSubjects).where(eq(teacherSubjects.teacherId, id));
      if (input.subjectIds.length)
        await tx
          .insert(teacherSubjects)
          .values(input.subjectIds.map((subjectId) => ({ teacherId: id, subjectId })));
    }

    // REQ-009 / TASK-060: leaving FREELANCE closes the monthly ceiling — inside this tx, so the type change
    // and the closure land together or not at all. FT↔PT and FREELANCE→FREELANCE are not this case.
    if (shouldCloseCeiling(current.type, input.type)) {
      await closeFreelanceCeiling(tx, id);
    }
  });
  return loadTeacherFull(id);
}

/** Offboard a teacher (soft — TASK-029). Rejects with 409 if they have any future live booking (must be
 *  reassigned/cleared first); else archive + deactivate locally (freelance money is a local `bo.item`). */
export async function archiveTeacher(id: string) {
  const current = await db.query.teachers.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!current) throw notFound("ไม่พบครู");

  const today = bangkokNow().date;
  const future = await db.query.bookings.findFirst({
    where: (b, { and, eq, gte, notInArray }) =>
      and(
        eq(b.teacherId, id),
        gte(b.date, today),
        notInArray(b.status, ["CANCELLED", "NO_SHOW"]),
      ),
  });
  if (future)
    throw conflict(
      "HAS_FUTURE_BOOKINGS",
      "ครูมีคาบล่วงหน้าที่ยังไม่ปิด — โปรดย้ายหรือยกเลิกคาบก่อนปิดการใช้งานครู",
    );

  await db.transaction(async (tx) => {
    await tx.update(teachers).set({ archived: true, active: false }).where(eq(teachers.id, id));
    // REQ-009 / TASK-060: archiving also ends the freelance arrangement. Without this the dead budget is
    // re-filled to its ceiling every month forever — `resetFreelanceBudgets` joins no teacher table, so it
    // can't tell an archived teacher from a working one. No-op for FT/PT.
    await closeFreelanceCeiling(tx, id);
  });
  return loadTeacherFull(id);
}

/** Bring an archived teacher back (standalone — TASK-029): un-archive + reactivate locally. Money is
 *  re-set via the admin UI (until then a freelance teacher shows `setupIncomplete`). */
export async function reactivateTeacher(id: string) {
  const current = await db.query.teachers.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!current) throw notFound("ไม่พบครู");
  await db.update(teachers).set({ archived: false, active: true }).where(eq(teachers.id, id));
  return loadTeacherFull(id);
}

// ───────────────────── Local freelance budget admin (SPEC-005 / TASK-019) ─────────────────────

/** Upsert a freelance teacher's ceiling as a `bo.item` (unit=hour). The admin contract stays baht:
 *  hours = round(monthlyBudget / rate). First set makes `remaining = ceiling`; an edit changes
 *  ceiling/rate/threshold but does NOT overwrite `remaining` (edit = next-reset target; use top-up). */
export async function setFreelanceBudget(
  teacherId: string,
  input: { monthlyBudgetMinor: number; rateMinor: number; reorderMinor?: number | null },
) {
  const teacher = await db.query.teachers.findFirst({ where: (t, { eq }) => eq(t.id, teacherId) });
  if (!teacher) throw notFound("ไม่พบครู");
  if (input.rateMinor <= 0) throw badRequest("เรทต่อชั่วโมงต้องมากกว่า 0");

  const ceilingQty = Math.round(input.monthlyBudgetMinor / input.rateMinor);
  const reorderQty =
    input.reorderMinor != null ? Math.round(input.reorderMinor / input.rateMinor) : null;
  const existing = await findFreelanceItem(db, teacherId);

  if (existing) {
    await db
      .update(boItem)
      .set({
        ceilingQty,
        unitPriceMinor: input.rateMinor,
        metadata: { ...(existing.metadata ?? {}), kind: FREELANCE_KIND, reorderQty },
        // remaining_qty NOT overwritten on edit
      })
      .where(eq(boItem.id, existing.id));
  } else {
    await db.insert(boItem).values({
      name: `ครูฟรีแลนซ์ ${teacher.nickname}`,
      unit: "ชั่วโมง",
      direction: "EXPENSE",
      cadence: "FIXED_MONTHLY",
      ceilingQty,
      remainingQty: ceilingQty, // first set → full ceiling
      unitPriceMinor: input.rateMinor,
      ownerRef: teacherId,
      externalSource: SCHED_SOURCE,
      metadata: { kind: FREELANCE_KIND, reorderQty },
    });
  }
  return loadTeacherFull(teacherId);
}

/** Top up remaining now (unlock a capped teacher / add mid-month hours). amount is baht → hours. */
export async function topUpFreelanceBudget(teacherId: string, amountMinor: number) {
  const item = await findFreelanceItem(db, teacherId);
  if (!item) throw notFound("ครูยังไม่ได้ตั้งงบ — ตั้งงบก่อนจึงจะเติมได้");
  const hours = Math.round(amountMinor / item.unitPriceMinor);
  await db
    .update(boItem)
    .set({ remainingQty: sql`${boItem.remainingQty} + ${hours}` })
    .where(eq(boItem.id, item.id));
  return loadTeacherFull(teacherId);
}

/** Monthly reset: every freelance ceiling's `remaining` back to its `ceiling` (the month-reset job). */
export async function resetFreelanceBudgets() {
  const rows = await db
    .update(boItem)
    .set({ remainingQty: sql`${boItem.ceilingQty}` })
    .where(
      and(
        eq(boItem.externalSource, SCHED_SOURCE),
        eq(boItem.active, true),
        sql`${boItem.metadata}->>'kind' = ${FREELANCE_KIND}`,
      ),
    )
    .returning({ id: boItem.id });
  return { reset: rows.length };
}

// Ops teacher↔party drift report (SPEC-004 #5.2 / TASK-018) removed by TASK-029: the backoffice `ops`
// party model is retired (freelance money is a local `bo.item`), so there is no external roster to
// reconcile against. `GET /api/teachers/reconcile` was removed with it.

export async function updateCourse(id: string, input: { adminUnlocked?: boolean }) {
  if (input.adminUnlocked !== undefined) {
    await db
      .update(coursePackages)
      .set({ adminUnlocked: input.adminUnlocked })
      .where(eq(coursePackages.id, id));
  }
  const row = await db.query.coursePackages.findFirst({
    where: (c, { eq }) => eq(c.id, id),
    with: { student: true },
  });
  if (!row) throw notFound("ไม่พบคอร์ส");
  return toCourseWithStudent(row);
}
