import { db } from "../db";
import { notFound, badRequest } from "../lib/http";
import { isWithinCheckinWindow, checkinWindowMessage } from "../lib/checkin";
import { formatCheckinPayload, issueCheckinToken } from "../lib/checkin-token";
import { CRM_POINT_RULES } from "../lib/crm";
import { awardCrmPoints } from "../lib/line-admin";
import { hhmm } from "../lib/time";
import { updateBookingStatus } from "./scheduler.service";
import { toBookingDTO } from "../db/mappers";

const withBookingRelations = {
  student: true,
  teacher: true,
  subject: true,
  course: true,
} as const;

async function loadBooking(id: string) {
  const row = await db.query.bookings.findFirst({
    where: (b, { eq: e }) => e(b.id, id),
    with: withBookingRelations,
  });
  return row ? toBookingDTO(row) : null;
}

export async function getCheckinQr(bookingId: string) {
  const row = await db.query.bookings.findFirst({
    where: (b, { eq: e }) => e(b.id, bookingId),
    with: { student: true },
  });
  if (!row) throw notFound("ไม่พบคาบเรียน");
  if (!row.checkinToken) {
    const issued = await issueCheckinToken(bookingId);
    if (!issued) throw notFound("ไม่พบคาบเรียน");
    return formatCheckinPayload(row, issued.token, issued.expiresAt);
  }
  return formatCheckinPayload(
    row,
    row.checkinToken,
    row.checkinTokenExpiresAt?.toISOString() ?? "",
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
  if (!isWithinCheckinWindow(row.date, hhmm(row.startTime), hhmm(row.endTime))) {
    throw badRequest(
      checkinWindowMessage(row.date, hhmm(row.startTime), hhmm(row.endTime)),
    );
  }

  const result = await updateBookingStatus(row.id, "attend");
  await awardCrmPoints(row.studentId, CRM_POINT_RULES.ON_TIME_CHECKIN);
  return { already: false, booking: result.booking, crmAwarded: CRM_POINT_RULES.ON_TIME_CHECKIN };
}

/** Parent LINE userId → today's CONFIRMED bookings for that parent's children. */
export async function findTodayBookingsForParent(lineUserId: string, date: string) {
  const parent = await db.query.parents.findFirst({
    where: (p, { eq: e }) => e(p.lineUserId, lineUserId),
  });
  if (!parent) return [];
  const linked = await db.query.students.findMany({
    where: (s, { eq: e }) => e(s.parentId, parent.id),
  });
  if (!linked.length) return [];
  const ids = linked.map((s) => s.id);
  return db.query.bookings.findMany({
    where: (b, { and, eq, inArray }) =>
      and(eq(b.date, date), eq(b.status, "CONFIRMED"), inArray(b.studentId, ids)),
    with: { student: true, teacher: true, subject: true },
    orderBy: (b, { asc }) => asc(b.startTime),
  });
}
