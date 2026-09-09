import { db } from "../db";
import { CALENDAR_HIDDEN_STATUSES } from "../db/schema";
import { notFound, badRequest } from "../lib/http";
import { isWithinCheckinWindow, checkinWindowMessage } from "../lib/checkin";
import { formatCheckinPayload, issueCheckinToken } from "../lib/checkin-token";
import { CRM_POINT_RULES } from "../lib/crm";
import { awardCrmPoints } from "../lib/line-admin";
import { getSetting } from "./settings.service";
import { hhmm } from "../lib/time";
import { bookingsWithRentals, updateBookingStatus } from "./scheduler.service";
import { toBookingDTO } from "../db/mappers";
import { findParentByLineUserId } from "./parent.service";

const withBookingRelations = {
  student: true,
  teacher: true,
  subject: true,
  course: true,
  // TASK-224 (AC-18) — same shape as the scheduler's loader: the check-in screen renders the same cell as the
  // calendar, so it must resolve a booking's teachers the same way rather than showing only the first.
  additionalTeachers: { with: { teacher: true } },
} as const;

async function loadBooking(id: string) {
  const row = await db.query.bookings.findFirst({
    where: (b, { eq: e }) => e(b.id, id),
    with: withBookingRelations,
  });
  if (!row) return null;
  // TASK-190: the check-in screen shows the same cell markers as the calendar, so it resolves the same way.
  const rented = await bookingsWithRentals([row.id]);
  return toBookingDTO(row, { hasRental: rented.has(row.id) });
}

export async function getCheckinQr(bookingId: string) {
  const row = await db.query.bookings.findFirst({
    where: (b, { eq: e }) => e(b.id, bookingId),
    with: { student: true },
  });
  if (!row) throw notFound("ไม่พบคาบเรียน");
  const { value: earlyMinutes } = await getSetting("checkin_early_minutes");
  if (!row.checkinToken) {
    const issued = await issueCheckinToken(bookingId);
    if (!issued) throw notFound("ไม่พบคาบเรียน");
    return formatCheckinPayload(row, issued.token, issued.expiresAt, earlyMinutes);
  }
  return formatCheckinPayload(
    row,
    row.checkinToken,
    row.checkinTokenExpiresAt?.toISOString() ?? "",
    earlyMinutes,
  );
}

export async function checkinByToken(token: string) {
  const row = await db.query.bookings.findFirst({
    where: (b, { eq: e }) => e(b.checkinToken, token),
  });
  if (!row) throw notFound("โทเคนเช็คอินไม่ถูกต้อง");
  if (row.status === "ATTENDED") {
    return { already: true, booking: await loadBooking(row.id) };
  }
  if (row.status !== "CONFIRMED") {
    throw badRequest("คาบนี้ยังไม่พร้อมเช็คอิน (ต้องยืนยันตารางก่อน)");
  }
  if (row.checkinTokenExpiresAt && row.checkinTokenExpiresAt < new Date()) {
    throw badRequest("โทเคนเช็คอินหมดอายุแล้ว");
  }
  // SPEC-029: the early-window is a configurable rule — resolve at action time, pass into the pure check.
  const { value: earlyMinutes } = await getSetting("checkin_early_minutes");
  if (!isWithinCheckinWindow(row.date, hhmm(row.startTime), hhmm(row.endTime), undefined, earlyMinutes)) {
    throw badRequest(
      checkinWindowMessage(row.date, hhmm(row.startTime), hhmm(row.endTime), earlyMinutes),
    );
  }

  const result = await updateBookingStatus(row.id, "attend");
  await awardCrmPoints(row.studentId, CRM_POINT_RULES.ON_TIME_CHECKIN);
  return { already: false, booking: result.booking, crmAwarded: CRM_POINT_RULES.ON_TIME_CHECKIN };
}

/**
 * The student ids of the family behind a parent's LINE account. Empty when the account is not a parent's.
 *
 * 🔴 TASK-259 — through the ONE resolver, not a hand-rolled copy of it.
 *
 * 📌 This WAS the second copy of the two-step, written out by hand — which is exactly why a grep for
 * `findParentByLineUserId` never counted it, and why it would have been the one site left behind when every
 * other inbound path moved. A family's second account reaches its children through the same door as the
 * first, or it reaches nothing.
 * 🔑 TASK-316 — extracted the moment there were TWO windows over the same family. **The window is the only
 * thing that differs between the two queries below; who the family IS must not be able to differ at all.**
 */
async function linkedStudentIds(lineUserId: string): Promise<string[]> {
  const parent = await findParentByLineUserId(lineUserId);
  if (!parent) return [];
  const linked = await db.query.students.findMany({
    where: (s, { eq: e }) => e(s.parentId, parent.id),
  });
  return linked.map((s) => s.id);
}

/** Parent LINE userId → today's CONFIRMED bookings for that parent's children. */
export async function findTodayBookingsForParent(lineUserId: string, date: string) {
  const ids = await linkedStudentIds(lineUserId);
  if (!ids.length) return [];
  return db.query.bookings.findMany({
    where: (b, { and, eq, inArray }) =>
      and(eq(b.date, date), eq(b.status, "CONFIRMED"), inArray(b.studentId, ids)),
    with: { student: true, teacher: true, subject: true },
    orderBy: (b, { asc }) => asc(b.startTime),
  });
}

/**
 * 🔴 TASK-316 (`REQ-085 §14`) — parent LINE userId → every UPCOMING CONFIRMED booking, from `fromDate` on.
 *
 * The leave flow already scanned, asked which child and named the session; **the only thing wrong was that its
 * window was one day wide** — *"a parent whose child has a class on THURSDAY is told, on Tuesday, that there is
 * nothing to do"*. ⚠️ Today's window stays for check-in and `qr`, which really are about today.
 * 🚫 No horizon: a course is finite and its sessions are the answer to *"what does this family have?"*. The
 * caller trims to what LINE can show, and that limit is LINE's rather than one invented here.
 */
export async function findUpcomingBookingsForParent(lineUserId: string, fromDate: string) {
  const ids = await linkedStudentIds(lineUserId);
  if (!ids.length) return [];
  return db.query.bookings.findMany({
    where: (b, { and, eq, gte, inArray }) =>
      and(gte(b.date, fromDate), eq(b.status, "CONFIRMED"), inArray(b.studentId, ids)),
    with: { student: true, teacher: true, subject: true },
    orderBy: (b, { asc }) => [asc(b.date), asc(b.startTime)],
  });
}

/** Teacher LINE userId → their own bookings in [from..to] (REQ-016 / TASK-043). Excludes CANCELLED; every
 *  other status is returned with its label. Teacher is resolved from the caller's own lineUserId — never a
 *  payload id. Empty when not linked. Read-only. */
export async function findBookingsForTeacher(lineUserId: string, from: string, to: string) {
  const teacher = await db.query.teachers.findFirst({
    where: (t, { eq: e }) => e(t.lineUserId, lineUserId),
  });
  if (!teacher) return [];
  // 🔴 TASK-271 §3 — `CALENDAR_HIDDEN_STATUSES`, not a hand-written `ne(status, "CANCELLED")`.
  //
  // That list's own comment names this exact bug: *"a hand-written exclusion of one status is exactly how
  // the next status gets missed"*. TASK-260 wrote that sentence, fixed the instance it found, and **this
  // identical line survived in another file** — so a paused booking stayed on a coach's phone.
  //
  // ✅ Reused rather than invented: a teacher's `ตาราง` IS a calendar, so *"does it appear on the grid?"*
  // is the same question with the same answer, and REQ-076 already settled that a paused booking leaves
  // the schedule. 🚫 A `TEACHER_SCHEDULE_HIDDEN_STATUSES` whose contents equal an existing list is the
  // disagreement this project keeps paying for.
  // 📌 `CANCELLED`'s behaviour is unchanged; `PAUSED` is the only row that stops appearing.
  return db.query.bookings.findMany({
    where: (b, { and, eq, notInArray, gte, lte }) =>
      and(
        eq(b.teacherId, teacher.id),
        gte(b.date, from),
        lte(b.date, to),
        notInArray(b.status, [...CALENDAR_HIDDEN_STATUSES]),
      ),
    with: { student: true, subject: true },
    orderBy: (b, { asc }) => [asc(b.date), asc(b.startTime)],
  });
}
