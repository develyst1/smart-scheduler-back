// Business logic — the source of truth for scheduling. Routes stay thin and call
// these; all domain rules (quota/extension/idempotency) live here.

import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { appSettings, bookings, coursePackages, freelanceBudgets, students, subjects, teacherSubjects, teachers, vouchers } from "../db/schema";
import type { TeacherType } from "../types/contract";
import { toBookingDTO, toCourseWithStudent, toTeacherDTO, toVoucherDTO } from "../db/mappers";
import { canTakeLeave } from "../lib/leave";
import { hasEnoughLeaveNotice, leaveNoticeMessage } from "../lib/leave-notice";
import { courseExpiry, courseSessionDates, isCourseSize, weekdayOf } from "../lib/recurring";
import { teacherWorksOnDay } from "../lib/work-days";
import { isVoucherHours, voucherExpiry, voucherUsable } from "../lib/voucher";
import { enqueueLine, type NotifyResult } from "../lib/line";
import {
  onboardOpsTeacher,
  updateOpsTeacher,
  offboardOpsTeacher,
  switchTypeOpsTeacher,
  fetchOpsPartyRefs,
  fetchOpsBudgetRefs,
  fetchOpsOpenSalaryRefs,
  reconcileTeacherDrift,
  recordSale,
} from "../lib/ops-client";
import { freelanceDraw, overLimit } from "../lib/freelance-budget";
import { bangkokNow } from "../lib/bangkok-time";
import { awardCrmPoints, notifyAdmins } from "../lib/line-admin";
import { findOrCreateParentByPhone } from "./parent.service";
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

// SPEC-005: re-source the freelance budget DTO fields from the LOCAL `freelance_budgets` table
// (no ops fetch). Same field names as the old ops-sourced attach → the FE is unchanged. Also sets
// `setupIncomplete` (FREELANCE with no budget row → true; FT/PT are not gated now — salary deferred).
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
  const rows = await db.query.freelanceBudgets.findMany();
  const map = new Map(rows.map((r) => [r.teacherId, r]));
  for (const d of dtos) {
    const b = map.get(d.id);
    if (b) {
      d.hourlyRate = b.rateMinor / 100;
      d.budgetMinor = b.monthlyBudgetMinor;
      d.remainingMinor = b.remainingMinor;
      d.reorderMinor = b.reorderMinor;
      d.overLimit = overLimit(b.remainingMinor);
    }
    d.setupIncomplete = d.type === "FREELANCE" && !b && !d.archived;
  }
  return dtos;
}

/** Booking gate (SPEC-005, local): a FREELANCE teacher with no budget row can't be booked; FT/PT ok. */
async function isFreelanceSetupIncomplete(exec: any, teacherId: string, type: TeacherType) {
  if (type !== "FREELANCE") return false;
  const b = await exec.query.freelanceBudgets.findFirst({
    where: (x: any, { eq }: any) => eq(x.teacherId, teacherId),
  });
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
  const rows = await db.query.coursePackages.findMany({ with: { student: true } });
  return rows.map(toCourseWithStudent);
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
  void recordSale(`course-${input.size}`, 1, {
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
  void recordSale(`voucher-${input.totalHours}`, 1, {
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
  // Set inside the tx when a *committed* freelance booking is cancelled/left, so the budget
  // drawdown is reversed post-commit (SPEC-001 / TASK-002).
  let releaseFreelanceTeacherId: string | null = null;
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

        // SPEC-005 (TASK-019): committing a freelance booking draws its rate from the teacher's LOCAL
        // budget — same DB tx as the confirm, so it's atomic (no cross-system orphan, no cache lag).
        // Insufficient budget with no override → rolls back the whole confirm (over-booking prevention).
        if (teacher?.type === "FREELANCE") {
          const budget = await tx.query.freelanceBudgets.findFirst({
            where: (b, { eq }) => eq(b.teacherId, current.teacherId),
          });
          if (budget) {
            const allowNegative = override || (await readLimitOverride(tx, current.teacherId));
            const draw = freelanceDraw(budget.remainingMinor, budget.rateMinor, allowNegative);
            if (draw.blocked) {
              throw conflict(
                "INSUFFICIENT_BUDGET",
                "งบครูฟรีแลนซ์เต็มแล้ว — เติมงบหรือปลดล็อกก่อนยืนยันคาบ",
              );
            }
            await tx
              .update(freelanceBudgets)
              .set({ remainingMinor: draw.remainingAfter })
              .where(eq(freelanceBudgets.teacherId, current.teacherId));
          }
        }
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
      // Reverse only a booking that was actually drawn (confirmed) and not already released.
      if (current.confirmedAt && (current.status === "CONFIRMED" || current.status === "ATTENDED"))
        releaseFreelanceTeacherId = current.teacherId;
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
      // Reverse only a booking that was actually drawn (confirmed) and not already released.
      if (current.confirmedAt && (current.status === "CONFIRMED" || current.status === "ATTENDED"))
        releaseFreelanceTeacherId = current.teacherId;

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

    // SPEC-005: cancel / customer-leave of a drawn freelance booking returns its rate to the local
    // budget — in the same tx (atomic). No-op for FT/PT or teachers without a budget row.
    if (releaseFreelanceTeacherId) {
      const rid = releaseFreelanceTeacherId;
      const budget = await tx.query.freelanceBudgets.findFirst({
        where: (b, { eq }) => eq(b.teacherId, rid),
      });
      if (budget) {
        await tx
          .update(freelanceBudgets)
          .set({ remainingMinor: budget.remainingMinor + budget.rateMinor })
          .where(eq(freelanceBudgets.teacherId, rid));
      }
    }

    const booking = await loadBookingDTO(tx, id);
    const extended = extendedId ? await loadBookingDTO(tx, extendedId) : null;
    return { booking, extended, course: booking.course, locked, notification };
  });

  return result;
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

/** Map a blocking ops teacher-sync failure to a clean 502 (so the FE shows "backoffice sync failed —
 *  retry"), while DB errors keep their own codes. The throw still rolls back the enclosing tx. */
async function opsSyncOr502<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch {
    throw new ApiException(502, "OPS_SYNC_FAILED", "ซิงก์กับ backoffice ไม่สำเร็จ — ลองใหม่อีกครั้ง");
  }
}

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

/** Create a teacher + its ops party in one flow. The ops onboard is BLOCKING and runs inside the tx,
 *  so a sync failure rolls back the insert — no teacher is ever left without a backoffice party (REQ #1.4). */
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
    await opsSyncOr502(onboardOpsTeacher(row.id, input.name)); // blocking; throw → rollback
    return row.id;
  });
  return loadTeacherFull(id);
}

/** Edit a teacher. Name change → ops party rename; **type change → close the OLD money** (switch-type,
 *  effective this month) — new money is set later via the admin UI. Both sync calls are blocking. */
export async function updateTeacher(
  id: string,
  input: { name?: string; nickname?: string; type?: TeacherType; subjectIds?: string[] },
) {
  const current = await db.query.teachers.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!current) throw notFound("ไม่พบครู");
  const nameChanged = input.name !== undefined && input.name !== current.name;
  const typeChanged = input.type !== undefined && input.type !== current.type;
  const month = bangkokNow().date.slice(0, 7);

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

    if (nameChanged) await opsSyncOr502(updateOpsTeacher(id, { displayName: input.name }));
    if (typeChanged) await opsSyncOr502(switchTypeOpsTeacher(id, month));
  });
  return loadTeacherFull(id);
}

/** Offboard a teacher (soft). Rejects with 409 if they have any future live booking (must be
 *  reassigned/cleared first); else archive + deactivate the ops party + stop money going forward. */
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
    await opsSyncOr502(offboardOpsTeacher(id, today.slice(0, 7))); // blocking
  });
  return loadTeacherFull(id);
}

/** Bring an archived teacher back: un-archive + reactivate the ops party. Money is re-set via the
 *  admin UI (until then the teacher shows `setupIncomplete`). */
export async function reactivateTeacher(id: string) {
  const current = await db.query.teachers.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!current) throw notFound("ไม่พบครู");
  await db.transaction(async (tx) => {
    await tx.update(teachers).set({ archived: false, active: true }).where(eq(teachers.id, id));
    await opsSyncOr502(updateOpsTeacher(id, { active: true })); // blocking
  });
  return loadTeacherFull(id);
}

// ───────────────────── Local freelance budget admin (SPEC-005 / TASK-019) ─────────────────────

/** Upsert a freelance teacher's budget. First set makes `remaining = monthlyBudget`; an edit changes
 *  budget/rate/threshold but does NOT overwrite `remaining` (edit = next-reset target; use top-up to
 *  change remaining now). */
export async function setFreelanceBudget(
  teacherId: string,
  input: { monthlyBudgetMinor: number; rateMinor: number; reorderMinor?: number | null },
) {
  const teacher = await db.query.teachers.findFirst({ where: (t, { eq }) => eq(t.id, teacherId) });
  if (!teacher) throw notFound("ไม่พบครู");
  const existing = await db.query.freelanceBudgets.findFirst({
    where: (b, { eq }) => eq(b.teacherId, teacherId),
  });
  if (existing) {
    await db
      .update(freelanceBudgets)
      .set({
        monthlyBudgetMinor: input.monthlyBudgetMinor,
        rateMinor: input.rateMinor,
        reorderMinor: input.reorderMinor ?? null,
      })
      .where(eq(freelanceBudgets.teacherId, teacherId));
  } else {
    await db.insert(freelanceBudgets).values({
      teacherId,
      monthlyBudgetMinor: input.monthlyBudgetMinor,
      rateMinor: input.rateMinor,
      remainingMinor: input.monthlyBudgetMinor, // first set → full budget
      reorderMinor: input.reorderMinor ?? null,
    });
  }
  return loadTeacherFull(teacherId);
}

/** Top up remaining now (unlock a capped teacher / add mid-month budget). */
export async function topUpFreelanceBudget(teacherId: string, amountMinor: number) {
  const existing = await db.query.freelanceBudgets.findFirst({
    where: (b, { eq }) => eq(b.teacherId, teacherId),
  });
  if (!existing) throw notFound("ครูยังไม่ได้ตั้งงบ — ตั้งงบก่อนจึงจะเติมได้");
  await db
    .update(freelanceBudgets)
    .set({ remainingMinor: existing.remainingMinor + amountMinor })
    .where(eq(freelanceBudgets.teacherId, teacherId));
  return loadTeacherFull(teacherId);
}

/** Monthly reset: every budget's `remaining` back to its `monthlyBudget` (the month-reset job). */
export async function resetFreelanceBudgets() {
  const rows = await db
    .update(freelanceBudgets)
    .set({ remainingMinor: sql`${freelanceBudgets.monthlyBudgetMinor}` })
    .returning({ teacherId: freelanceBudgets.teacherId });
  return { reset: rows.length };
}

/** Read-only teacher↔ops drift report (SPEC-004 #5.2 / TASK-018). Compares the scheduling roster (incl.
 *  archived) against live ops parties + money via the public ops GETs. No writes — repair is manual
 *  (re-run onboard/offboard). Fails cleanly (502) if backoffice is unreachable, rather than reporting
 *  false drift from empty responses. */
export async function reconcileTeachers() {
  let partyRefs: Set<string>, budgetRefs: Set<string>, salaryRefs: Set<string>;
  try {
    [partyRefs, budgetRefs, salaryRefs] = await Promise.all([
      fetchOpsPartyRefs(),
      fetchOpsBudgetRefs(),
      fetchOpsOpenSalaryRefs(),
    ]);
  } catch {
    throw new ApiException(502, "OPS_UNREACHABLE", "เชื่อมต่อ backoffice ไม่ได้ — ลองใหม่อีกครั้ง");
  }
  const rows = await db.query.teachers.findMany(); // includes archived
  const report = reconcileTeacherDrift(
    rows.map((t) => ({ id: t.id, archived: t.archived, type: t.type })),
    partyRefs,
    budgetRefs,
    salaryRefs,
  );
  return {
    ...report,
    repairHint:
      "Repair by re-running the teacher endpoints: missingParty → PATCH/re-onboard; moneyForArchived → re-archive (offboard).",
  };
}

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
