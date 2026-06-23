// Business logic — the source of truth for scheduling. Routes stay thin and call
// these; all domain rules (quota/extension/idempotency) live here.

import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, coursePackages, students, subjects, teachers } from "../db/schema";
import { toBookingDTO, toCourseWithStudent, toTeacherDTO } from "../db/mappers";
import { canTakeLeave } from "../lib/leave";
import { enqueueLine, type NotifyResult } from "../lib/line";
import { badRequest, conflict, notFound, pgErrorCode } from "../lib/http";
import { TIME_SLOTS, addDays, addHour, datesBetween, weekRange } from "../lib/time";

const PRIORITY: Record<string, number> = { FULL_TIME: 0, PART_TIME: 1, FREELANCE: 2 };

const withBookingRelations = {
  student: true,
  teacher: true,
  subject: true,
  course: true,
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

  const teacherRows = await db.query.teachers.findMany({
    where: (t, { eq }) => eq(t.active, true),
    with: { teacherSubjects: { with: { subject: true } } },
  });
  const teacherDtos = teacherRows
    .map(toTeacherDTO)
    .sort((a, b) => PRIORITY[a.type] - PRIORITY[b.type]);

  const bookingRows = await db.query.bookings.findMany({
    where: (b, { and, gte, lte, ne }) =>
      and(gte(b.date, range.start), lte(b.date, range.end), ne(b.status, "CANCELLED")),
    with: withBookingRelations,
  });

  const idx = new Map<string, ReturnType<typeof toBookingDTO>>();
  for (const row of bookingRows) {
    const dto = toBookingDTO(row);
    idx.set(`${dto.date}|${dto.teacher.id}|${dto.startTime}`, dto);
  }

  return {
    view: input.view,
    range: { from: range.start, to: range.end },
    timeSlots: [...TIME_SLOTS],
    days: days.map((date) => ({
      date,
      columns: teacherDtos.map((teacher) => ({
        teacher,
        slots: TIME_SLOTS.map((time) => ({
          time,
          booking: idx.get(`${date}|${teacher.id}|${time}`) ?? null,
        })),
      })),
    })),
  };
}

export async function getTeachers() {
  const rows = await db.query.teachers.findMany({
    with: { teacherSubjects: { with: { subject: true } } },
  });
  const dtos = rows.map(toTeacherDTO);
  const order: Array<"FULL_TIME" | "PART_TIME" | "FREELANCE"> = [
    "FULL_TIME",
    "PART_TIME",
    "FREELANCE",
  ];
  return {
    groups: order.map((type) => {
      const list = dtos.filter((t) => t.type === type);
      return { type, allActive: list.length > 0 && list.every((t) => t.active), teachers: list };
    }),
  };
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
    .where(eq(bookings.date, date));

  const count = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).length;
  const types = ["FIRST_TRIAL", "SINGLE_SESSION", "COURSE_PACKAGE", "VOUCHER"] as const;

  return {
    date,
    totalBooked: count((r) => r.status !== "CANCELLED"),
    attended: count((r) => r.status === "ATTENDED"),
    onLeave: count((r) => r.status === "SICK_LEAVE"),
    pending: count((r) => r.status === "PENDING"),
    cancelled: count((r) => r.status === "CANCELLED"),
    byBookingType: types.map((type) => ({ type, count: count((r) => r.bookingType === type) })),
  };
}

// ───────────────────────────── Writes ─────────────────────────────

export async function createBooking(input: any) {
  return await db.transaction(async (tx) => {
    let studentId: string;
    if ("id" in input.student) {
      studentId = input.student.id;
    } else {
      const [s] = await tx
        .insert(students)
        .values({
          name: input.student.name,
          nickname: input.student.nickname ?? input.student.name,
          phone: input.student.phone ?? null,
          parentLineUserId: input.student.parentLineUserId ?? null,
        })
        .returning({ id: students.id });
      studentId = s.id;
    }

    let id: string;
    try {
      const [row] = await tx
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
        })
        .returning({ id: bookings.id });
      id = row.id;
    } catch (e: any) {
      const code = pgErrorCode(e);
      if (code === "23505") throw conflict("SLOT_TAKEN", "ครูมีคาบในช่วงเวลานี้แล้ว");
      if (code === "23503") throw badRequest("teacher / subject / course อ้างอิงไม่ถูกต้อง");
      throw e;
    }

    const booking = await loadBookingDTO(tx, id);
    return { booking, course: booking.course };
  });
}

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

export async function updateBookingStatus(id: string, action: string, reason?: string) {
  return await db.transaction(async (tx) => {
    const current = await tx.query.bookings.findFirst({
      where: (b, { eq }) => eq(b.id, id),
      with: { course: true },
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
      }
    } else if (action === "cancel") {
      await tx
        .update(bookings)
        .set({ status: "CANCELLED", note: reason ?? current.note })
        .where(eq(bookings.id, id));
    } else if (action === "sick-leave") {
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
    } else {
      throw badRequest(`action ไม่รองรับ: ${action}`);
    }

    const booking = await loadBookingDTO(tx, id);
    const extended = extendedId ? await loadBookingDTO(tx, extendedId) : null;
    return { booking, extended, course: booking.course, locked, notification };
  });
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
