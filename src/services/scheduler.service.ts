// Business logic — the source of truth for scheduling. Routes stay thin and call
// these; all domain rules (quota/extension/idempotency) live here.

import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { appSettings, bookings, boItem, boMovement, coursePackages, students, subjects, teacherSubjects, teachers, vouchers } from "../db/schema";
import type { BulkConfirmResult, TeacherType } from "../types/contract";
import { preCheckBulkConfirm } from "../lib/bulk-confirm";
import { toBookingDTO, toCourseWithStudent, toTeacherDTO, toVoucherDTO } from "../db/mappers";
import { canTakeLeave } from "../lib/leave";
import { hasEnoughLeaveNotice, leaveNoticeMessage } from "../lib/leave-notice";
import { courseExpiry, courseSessionDates, isCourseSize, weekdayOf } from "../lib/recurring";
import { teacherWorksOnDay } from "../lib/work-days";
import { isVoucherHours, voucherExpiry, voucherUsable } from "../lib/voucher";
import { enqueueLine, type NotifyResult } from "../lib/line";
import { recordSale } from "../lib/sale-post";
import { courseItemRef, voucherItemRef } from "../lib/sale-items";
import {
  drawCeilingHour,
  heldTarget,
  overLimit,
  reconcileDelta,
  reconcileRemaining,
  shouldCloseCeiling,
} from "../lib/freelance-budget";
import { bangkokNow } from "../lib/bangkok-time";
import { awardCrmPoints, notifyAdmins } from "../lib/line-admin";
import { findOrCreateParentByPhone, findParentOfStudent, suspendedStudentIds } from "./parent.service";
import { blockedBySuspension } from "../lib/suspend";
import { courseEligible, courseRemainingSessions, voucherEligible } from "../lib/eligibility";
import { attachBookingBadges } from "./badge.service";
import { issueCheckinToken } from "../lib/checkin-token";
import { CRM_POINT_RULES } from "../lib/crm";
import { badRequest, conflict, notFound, pgErrorCode } from "../lib/http";
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

// Reconcile a freelance booking's ceiling drawdown to its status (REQ-006 / TASK-028). `held ∈ {0,1}` is
// derived from the net `bo.movement(refId=booking)` on the teacher's ceiling item — the single source of
// truth — so any status round-trip is idempotent and can never inflate `remaining` past the ceiling. Posts
// at most one movement to move held → target(status); no-op when already there. Runs inside the caller's tx
// (atomic, same DB). No-op for non-FREELANCE teachers or a teacher with no ceiling item.
async function reconcileFreelanceDraw(
  tx: any,
  bookingId: string,
  teacherId: string,
  status: string,
  override: boolean,
) {
  const teacher = await tx.query.teachers.findFirst({
    where: (t: any, { eq }: any) => eq(t.id, teacherId),
  });
  if (teacher?.type !== "FREELANCE") return;

  const item = await findFreelanceItem(tx, teacherId);
  if (!item || item.remainingQty === null) return;

  // held = −Σ(movement.qty) for this booking on this item (a draw is qty −1 → held +1).
  const movements = await tx.query.boMovement.findMany({
    where: (m: any, { and, eq }: any) => and(eq(m.itemId, item.id), eq(m.refId, bookingId)),
  });
  const held = -movements.reduce((sum: number, m: any) => sum + m.qty, 0);

  const delta = reconcileDelta(held, status);
  if (delta === 0) return; // already at target — idempotent no-op

  const allowNegative = override || (await readLimitOverride(tx, teacherId));
  if (delta > 0 && drawCeilingHour(item.remainingQty, allowNegative).blocked) {
    throw conflict(
      "INSUFFICIENT_BUDGET",
      "งบครูฟรีแลนซ์เต็มแล้ว — เติมงบหรือปลดล็อกก่อนยืนยันคาบ",
    );
  }

  const qty = -delta; // draw → −1, refund → +1
  const remainingAfter = reconcileRemaining(item.remainingQty, item.ceilingQty ?? item.remainingQty, delta);
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
      idempotencyKey: `fl:${bookingId}:held${heldTarget(status)}`,
    })
    .onConflictDoNothing();
}

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

export async function getCourses() {
  // Load one booking's subject per course to surface the sport program (a course ⇔ one subject; REQ-010).
  const rows = await db.query.coursePackages.findMany({
    with: { student: true, bookings: { with: { subject: true }, limit: 1 } },
  });
  return rows.map(toCourseWithStudent);
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
export async function getEligibleStudents(type: string) {
  const { date } = bangkokNow();
  // REQ-019 / TASK-056: this endpoint exists ONLY to answer "who can be booked", so a suspended household
  // never belongs in it — filtered unconditionally. Parentless walk-in students are never in the set.
  const suspended = await suspendedStudentIds();

  if (type === "COURSE_PACKAGE") {
    const courses = await getCourses();
    return {
      students: courses
        .filter((c: any) => courseEligible(c, date) && !suspended.has(c.student.id))
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
        .filter((v: any) => voucherEligible(v, date) && !suspended.has(v.student.id))
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

export async function getBookings(f: {
  from?: string;
  to?: string;
  type?: any;
  status?: any;
  teacherId?: string;
  q?: string;
  page: number;
  limit: number;
}) {
  // q searches student & subject names → resolve to ids first (keeps it one query each)
  let studentIds: string[] | null = null;
  let subjectIds: string[] | null = null;
  if (f.q) {
    studentIds = (
      await db.select({ id: students.id }).from(students).where(ilike(students.name, `%${f.q}%`))
    ).map((r) => r.id);
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
    .orderBy(asc(bookings.date), asc(bookings.startTime))
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

async function insertBooking(
  exec: any,
  studentId: string,
  input: any,
  opts: { pendingSlot?: boolean } = {},
): Promise<string> {
  const teacher = await exec.query.teachers.findFirst({
    where: (t: any, { eq }: any) => eq(t.id, input.teacherId),
  });
  if (!teacher) throw badRequest("ไม่พบครู");
  if (teacher.archived) throw badRequest(`ครู${teacher.nickname} ถูกปิดการใช้งานแล้ว`);
  if (!teacherWorksOnDay(teacher.workDays, weekdayOf(input.date))) {
    throw badRequest(`ครู${teacher.nickname} ไม่มาสอนวันนี้`);
  }
  // SPEC-005 server backstop to the FE `bookable` gate: a FREELANCE teacher with no budget row can't
  // be booked (FT/PT are not gated — salary deferred).
  if (await isFreelanceSetupIncomplete(exec, teacher.id, teacher.type)) {
    throw badRequest(`ครู${teacher.nickname} ยังไม่ได้ตั้งงบ — ตั้งงบก่อนจึงจะจองได้`);
  }
  // REQ-019 / TASK-048: a suspended household gets no NEW bookings (existing ones are untouched). Server-side,
  // so hiding the button in the UI isn't the only defence. Walk-in students with no parent are never blocked.
  if (blockedBySuspension(await findParentOfStudent(studentId, exec))) {
    throw badRequest(`${SUSPENDED_MESSAGE}จอง`);
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
        status: "PENDING",
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

export async function createBooking(input: any) {
  return await db.transaction(async (tx) => {
    const studentId = await resolveStudentId(tx, input.student);
    if (input.bookingType === "VOUCHER" && input.voucherId) {
      await prepareVoucherBooking(tx, input.voucherId, input.date, studentId);
    }
    const id = await insertBooking(tx, studentId, input);
    if (input.badgeValueIds?.length) {
      await attachBookingBadges(tx, id, input.badgeValueIds);
    }
    const booking = await loadBookingDTO(tx, id);
    return { booking, course: booking.course };
  });
}

// ───────────────────── Course package + voucher (B.4 / B.5) ─────────────────────

// Register a 4/6/10-session course: create the package and lock its weekly slots
// forward (auto-recurring). A clash on any week aborts the whole registration.
export async function createCoursePackage(input: any) {
  if (!isCourseSize(input.size)) throw badRequest("ขนาดคอร์สต้องเป็น 4, 6 หรือ 10");
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
        startDate: input.startDate,
        weekday: weekdayOf(input.startDate),
        startTime: input.startTime,
        expiryDate: courseExpiry(input.startDate, input.size),
      })
      .returning({ id: coursePackages.id });

    for (const date of courseSessionDates(input.startDate, input.size)) {
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
  void recordSale(courseItemRef(input.size), 1, {
    refId: result.course.id,
    idempotencyKey: `course-sale:${result.course.id}`,
  });

  return result;
}

// List vouchers for the voucher tab + the booking picker. Optional studentId
// (booking modal loads a student's own vouchers) / q (name search).
export async function getVouchers(f: { studentId?: string; q?: string } = {}) {
  const rows = await db.query.vouchers.findMany({
    where: f.studentId ? (v, { eq }) => eq(v.studentId, f.studentId!) : undefined,
    with: { student: true },
    orderBy: (v, { desc }) => desc(v.createdAt),
  });
  let list = rows.map(toVoucherDTO);
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter(
      (v) =>
        v.student.name.toLowerCase().includes(q) ||
        (v.student.nickname ?? "").toLowerCase().includes(q),
    );
  }
  return list;
}

// Issue a voucher (5/10/15h). Validity starts at the first booking (B.5); a
// provisional expiry from today keeps the NOT NULL column valid until then.
export async function createVoucher(input: any) {
  if (!isVoucherHours(input.totalHours))
    throw badRequest("จำนวนชั่วโมงวอยเชอร์ต้องเป็น 5, 10 หรือ 15");
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
) {
  let d = addDays(fromDate, 7);
  for (let i = 0; i < 26; i++) {
    const clash = await exec.query.bookings.findFirst({
      where: (b: any, { and, eq, ne }: any) =>
        and(eq(b.teacherId, teacherId), eq(b.date, d), eq(b.startTime, startTime), ne(b.status, "CANCELLED")),
    });
    if (!clash) return d;
    d = addDays(d, 7);
  }
  return d;
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
      await tx
        .update(bookings)
        .set({ status: "CANCELLED", note: reason ?? current.note })
        .where(eq(bookings.id, id));
    } else if (action === "sick-leave") {
      // Advance-notice rule (UC-029): leave must be requested early enough for the
      // teacher's type (FT/PT ≥ 1h, FL ≥ 2h). Admin may override for special cases.
      if (!override) {
        const teacher = await tx.query.teachers.findFirst({
          where: (t, { eq }) => eq(t.id, current.teacherId),
        });
        if (
          teacher &&
          !hasEnoughLeaveNotice(current.date, current.startTime, teacher.type)
        ) {
          throw conflict("LEAVE_NOTICE_TOO_LATE", leaveNoticeMessage(teacher.type));
        }
      }

      await tx
        .update(bookings)
        .set({ status: "SICK_LEAVE", note: reason ?? current.note })
        .where(eq(bookings.id, id));

      if (current.courseId && current.course) {
        if (canTakeLeave(current.course)) {
          await tx
            .update(coursePackages)
            .set({ leaveUsed: current.course.leaveUsed + 1 })
            .where(eq(coursePackages.id, current.courseId));

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
      await notifyAdmins(
        {
          kind: "sick_leave",
          bookingId: id,
          studentName: student?.name ?? "",
          via: reason?.includes("LINE") ? "line" : "staff",
        },
        tx,
      );
    } else {
      throw badRequest(`action ไม่รองรับ: ${action}`);
    }

    // REQ-006 (TASK-028): reconcile the freelance ceiling drawdown to the booking's *actual* new status —
    // one idempotent movement, `held` derived from the ledger. Replaces the old draw-on-confirm /
    // refund-on-cancel-or-leave, which mutated `remaining` unconditionally and double-refunded on a status
    // round-trip (ATTENDED↔SICK_LEAVE) → `remaining` past ceiling. Consuming (keeps the draw): CONFIRMED /
    // ATTENDED / SICK_LEAVE / EXTENDED; releasing: NO_SHOW / CANCELLED / PENDING. The makeup EXTENDED row is
    // deliberately NOT reconciled here — it draws on its own confirm, preserving today's behavior.
    const after = await tx.query.bookings.findFirst({ where: (b, { eq }) => eq(b.id, id) });
    if (after) await reconcileFreelanceDraw(tx, id, current.teacherId, after.status, override);

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
    await db.update(bookings).set(patch).where(eq(bookings.id, id));
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
