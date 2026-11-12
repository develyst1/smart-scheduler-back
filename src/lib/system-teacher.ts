// 🔻 TASK-861 (REQ-120 F5) — the ONE system teacher, "No Teacher" (`teachers.is_system`, exactly one row): a park-fee block (an OTHER booking with a price, rented to an outside party) sits on the calendar without a real coach owning it.
// It is EXCLUDED from everything that measures, pays or messages a coach, and it is bookable ONLY for `OTHER`. Every consumer decides by the FLAG, never by the name.
import { db } from "../db";
import { ApiException } from "./http";

/** The row's name and nickname (data, not a label: the screens show the row's own name). */
export const SYSTEM_TEACHER_NAME = "No Teacher";

/**
 * 🔒 The refusals' words — NO new words: the approved archived-teacher sentence (`assertTeacherBookable`'s «ครู <nickname> ถูกปิดการใช้งานแล้ว»), reused for both codes. ONE function, so a different approved sentence is a one-line change.
 * (Silver asked to be told if no existing string fits: this is the closest one and is reported as such.)
 */
export const systemTeacherWords = (nickname: string): string => `ครู ${nickname} ถูกปิดการใช้งานแล้ว`;

/** 400 — the system teacher on a booking that is not `OTHER` (a lesson, a trial, a course, a voucher, a camp hour). */
export const SYSTEM_TEACHER_NOT_BOOKABLE = (nickname: string): ApiException => new ApiException(400, "SYSTEM_TEACHER_NOT_BOOKABLE", systemTeacherWords(nickname));
/** 409 — a write on the system teacher itself (edit, archive, pause, LINE link, leave, budget, work days …). */
export const SYSTEM_TEACHER = (nickname: string): ApiException => new ApiException(409, "SYSTEM_TEACHER", systemTeacherWords(nickname));

/** A teacher row (or DTO) is the system teacher — by the FLAG. */
export const isSystemTeacher = (t: { isSystem?: boolean | null } | null | undefined): boolean => !!t?.isSystem;

/** The route-level guard for the leave doors: a system-teacher id is refused 409 SYSTEM_TEACHER before the act runs (the act itself, with its many fake-db suites, is untouched). */
export const assertTeacherMayHaveLeave = (teacherId: string): Promise<void> => assertNotSystemTeacher(db, teacherId);

/**
 * 🔻 TASK-942 — is this booking a PARK block: an OTHER booking whose teacher ROW is the system teacher? Decided ONLY from the row's flag (one indexed read by primary key, in the caller's transaction) and the booking type — never from a request
 * field. It is what `bookings.slot_exempt` stores: a park block holds no coach-hour, so several groups may rent the park in one hour; every other booking (a real teacher's, or any non-OTHER type) stays exempt-FALSE and the index still refuses a double-booking.
 */
export async function isParkBlock(exec: any, teacherId: string, bookingType: string | null | undefined): Promise<boolean> {
  if (!mayUseSystemTeacher(bookingType)) return false; // only an OTHER can be a park block: no read needed for the rest
  const t = await exec.query.teachers.findFirst({ columns: { isSystem: true }, where: (x: any, { eq }: any) => eq(x.id, teacherId) });
  return isSystemTeacher(t);
}

/** Only an OTHER booking may use the system teacher. */
export const mayUseSystemTeacher = (bookingType: string | null | undefined): boolean => bookingType === "OTHER";

/**
 * Refuse a WRITE on the system teacher: reads the one flag by id (in the caller's transaction when it has one). An unknown id passes — the caller's own not-found runs next. 🔑 The read is a single indexed lookup by primary key.
 */
export async function assertNotSystemTeacher(exec: any, teacherId: string): Promise<void> {
  const t = await exec.query.teachers.findFirst({ columns: { isSystem: true, nickname: true }, where: (x: any, { eq }: any) => eq(x.id, teacherId) });
  if (isSystemTeacher(t)) throw SYSTEM_TEACHER(t.nickname);
}
