import { db } from "../db";
import { CALENDAR_HIDDEN_STATUSES } from "../db/schema";
import { ApiException, notFound, badRequest } from "../lib/http";

/** TASK-479 — the code of "the check-in link has expired" (session 400 · camp keeps its 410 `CAMP_TOKEN_EXPIRED` code). */
export const CHECKIN_TOO_LATE = "CHECKIN_TOO_LATE";
import { isWithinCheckinWindow, checkinWindowMessage } from "../lib/checkin";
import { formatCheckinPayload, issueCheckinToken } from "../lib/checkin-token";
import { CRM_POINT_RULES } from "../lib/crm";
import { awardCrmPoints } from "../lib/line-admin";
import { getNumberSetting, getSetting } from "./settings.service";
import { hhmm } from "../lib/time";
import { updateBookingStatus } from "./scheduler.service";
import { toBookingDTO } from "../db/mappers";
import { anyHouseholdSuspended, findParentByLineUserId } from "./parent.service";
import { tb } from "../lib/line-i18n";
import { duoStudentIds, familyRowsWhere } from "../lib/duo-course";

/**
 * TASK-443 (REQ-104 §2 item 5a) — what the family has left, on the scan page: the course's sessions (the DTO's summary) or the
 * voucher's hours (ONE read — the scan's relations never carried the voucher); `null` on a trial / single. No mask: the scan
 * is the family's own, by token.
 */
async function remainingOf(row: { voucherId?: string | null }, booking: any): Promise<{ used: number; total: number; unit: "sessions" | "hours" } | null> {
  if (booking?.course) return { used: booking.course.usedSessions, total: booking.course.size, unit: "sessions" };
  if (row.voucherId) {
    const v = await db.query.vouchers.findFirst({ where: (x, { eq: e }) => e(x.id, row.voucherId!) });
    if (v) return { used: v.usedHours, total: v.totalHours, unit: "hours" };
  }
  return null;
}

const withBookingRelations = {
  student: true,
  teacher: true,
  subject: true,
  course: true,
  // TASK-224 (AC-18) — same shape as the scheduler's loader: the check-in screen renders the same cell as the
  // calendar, so it must resolve a booking's teachers the same way rather than showing only the first.
  additionalTeachers: { with: { teacher: true } },
  // TASK-371 — the rental row rides here too, so the check-in screen shows the same `R` as the calendar.
  rental: true,
} as const;

async function loadBooking(id: string) {
  const row = await db.query.bookings.findFirst({
    where: (b, { eq: e }) => e(b.id, id),
    with: withBookingRelations,
  });
  if (!row) return null;
  return toBookingDTO(row);
}

export async function getCheckinQr(bookingId: string) {
  const row = await db.query.bookings.findFirst({
    where: (b, { eq: e }) => e(b.id, bookingId),
    with: { student: true, coStudent: true }, // TASK-425
  });
  if (!row) throw notFound("ไม่พบคาบเรียน");
  const { value: earlyMinutes } = await getSetting("checkin_early_minutes");
  const lateMinutes = await getNumberSetting("checkin_late_minutes"); // TASK-474
  if (!row.checkinToken) {
    const issued = await issueCheckinToken(bookingId, undefined, lateMinutes);
    if (!issued) throw notFound("ไม่พบคาบเรียน");
    return formatCheckinPayload(row, issued.token, issued.expiresAt, earlyMinutes, lateMinutes);
  }
  return formatCheckinPayload(
    row,
    row.checkinToken,
    row.checkinTokenExpiresAt?.toISOString() ?? "",
    earlyMinutes,
    lateMinutes,
  );
}

/**
 * The check-in act — the ONE every path runs (the token link, the LINE button, the shop-front QR).
 * TASK-475 — `source` is WHERE it came from, recorded on the booking (`checkin_source`): the token page `checkin-qr`
 * (the default, so the public route is unchanged), the bot `line`, the wall QR `shopfront-qr`.
 */
export async function checkinByToken(token: string, source: "checkin-qr" | "line" | "shopfront-qr" = "checkin-qr") {
  const row = await db.query.bookings.findFirst({
    where: (b, { eq: e }) => e(b.checkinToken, token),
  });
  if (!row) throw notFound(tb("checkin_bad_link")); // TASK-479 — the parent's words, not "token"
  // 🔴 TASK-476 — a SUSPENDED household is refused here as the LINE path refuses it: the same rule, the same words
  // (`suspended_notice`), and FIRST — before "already", so it gets no data back (REQ-019 / TASK-048).
  if (await anyHouseholdSuspended(duoStudentIds(row))) throw badRequest(tb("suspended_notice"));
  if (row.status === "ATTENDED") {
    const booking = await loadBooking(row.id);
    return { already: true, booking, remaining: await remainingOf(row, booking) };
  }
  // SPEC-029: the early-window is a configurable rule — resolve at action time, pass into the pure check.
  const { value: earlyMinutes } = await getSetting("checkin_early_minutes");
  const lateMinutes = await getNumberSetting("checkin_late_minutes"); // TASK-474 — the real setting, read the one way
  // 🔴 TASK-474 ruling 2 — a SETTLED row is never flipped by a late scan. ATTENDED answered "already" above (that is what
  // the day-end leaves a started class as); a NO_SHOW — staff's own mark — answers the window's "too late" and changes
  // NOTHING: re-opening a consumed unit hours after the shop closed its day is what nothing downstream expects.
  if (row.status === "NO_SHOW") {
    throw badRequest(checkinWindowMessage(row.date, hhmm(row.startTime), hhmm(row.endTime), earlyMinutes, lateMinutes));
  }
  if (row.status !== "CONFIRMED") {
    throw badRequest("คาบนี้ยังไม่พร้อมเช็คอิน (ต้องยืนยันตารางก่อน)");
  }
  // TASK-474 — a token minted BEFORE the late setting existed (or before it was raised) expires at the class end; inside
  // the late window it is still honoured, because the window — not the stored stamp — is the rule. With 0 this is
  // exactly the old check.
  const inLateWindow = lateMinutes > 0 && isWithinCheckinWindow(row.date, hhmm(row.startTime), hhmm(row.endTime), undefined, earlyMinutes, lateMinutes);
  if (row.checkinTokenExpiresAt && row.checkinTokenExpiresAt < new Date() && !inLateWindow) {
    // TASK-479 — the parent's words, and its own CODE so the LINE reply can answer in the chat's language. WHEN it fires is
    // TASK-474's rule and unchanged; the status stays 400 (the session page's contract).
    throw new ApiException(400, CHECKIN_TOO_LATE, tb("checkin_too_late"));
  }
  if (!isWithinCheckinWindow(row.date, hhmm(row.startTime), hhmm(row.endTime), undefined, earlyMinutes, lateMinutes)) {
    throw badRequest(
      checkinWindowMessage(row.date, hhmm(row.startTime), hhmm(row.endTime), earlyMinutes, lateMinutes),
    );
  }

  const result = await updateBookingStatus(row.id, "attend", undefined, false, undefined, source);
  for (const sid of duoStudentIds(row)) await awardCrmPoints(sid, CRM_POINT_RULES.ON_TIME_CHECKIN); // TASK-420 — both kids of a DUO row
  return { already: false, booking: result.booking, crmAwarded: CRM_POINT_RULES.ON_TIME_CHECKIN, remaining: await remainingOf(row, result.booking) };
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
export async function linkedStudentIds(lineUserId: string): Promise<string[]> { // TASK-420: exported — the leave's child step filters on it
  const parent = await findParentByLineUserId(lineUserId);
  if (!parent) return [];
  const linked = await db.query.students.findMany({
    where: (s, { eq: e, and: a, isNull: n }) => a(e(s.parentId, parent.id), n(s.archivedAt)), // TASK-392: an archived child is not offered
  });
  return linked.map((s) => s.id);
}

/** Parent LINE userId → today's CONFIRMED bookings for that parent's children. */
export async function findTodayBookingsForParent(lineUserId: string, date: string) {
  const ids = await linkedStudentIds(lineUserId);
  if (!ids.length) return [];
  return db.query.bookings.findMany({
    where: (b, { and, eq }) =>
      and(eq(b.date, date), eq(b.status, "CONFIRMED"), familyRowsWhere(ids)), // TASK-420 — primary OR co-student
    with: { student: true, coStudent: true, teacher: true, subject: true },
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
    where: (b, { and, eq, gte }) =>
      and(gte(b.date, fromDate), eq(b.status, "CONFIRMED"), familyRowsWhere(ids)), // TASK-420 — primary OR co-student
    with: { student: true, coStudent: true, teacher: true, subject: true },
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
    with: { student: true, coStudent: true, subject: true }, // TASK-425
    orderBy: (b, { asc }) => [asc(b.date), asc(b.startTime)],
  });
}
