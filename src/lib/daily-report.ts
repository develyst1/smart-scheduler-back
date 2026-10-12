// 🔻 TASK-737 (REQ-119) — the PURE counters of `GET /api/reports/daily`, Palm's contract (`smart-scheduler-front` → `docs/backend-daily-report.md` §2–§5, §8; his counting
// `src/lib/scheduler/daily-report.ts` L11–34). No database, no clock: the service reads the day's rows and hands them here, so every rule below is asserted with values.
//
// Palm's answers to his own open questions (Q1–Q6) are TEMPORARY — they live here as one exported constant/predicate each, mirroring his file, so that when the owner or ฟีน answers,
// the back and the front change together. 🚫 Nothing here "improves" them.

/** The four LESSON types — every stat card counts only these (ECA/Free/KOL/CAMP are `OTHER`, a DUO/Group row is `GROUP`). Fixed order = the order of `byBookingType*`. */
export const LESSON_TYPES = ["FIRST_TRIAL", "SINGLE_SESSION", "COURSE_PACKAGE", "VOUCHER"] as const;
export type LessonType = (typeof LESSON_TYPES)[number];

/**
 * 🔒 THE ONE SWITCH (REQ-119 ❓, the owner's ruling is pending — do NOT flip it here).
 *   true  = Palm: Total booked = every lesson that is neither CANCELLED nor PAUSED (Pending and Extended are IN) — what the front shows today, so the numbers do not jump at switch-over;
 *   false = the customer's Excel: Total booked = Confirmed + On leave (Pending OUT).
 */
export const TOTAL_BOOKED_INCLUDES_PENDING = true;

/** Palm Q1: NO_SHOW counts as Confirmed. */
export const CONFIRMED_STATUSES: ReadonlySet<string> = new Set(["CONFIRMED", "ATTENDED", "NO_SHOW"]);
/** Palm Q2: EXTENDED counts as Pending. */
export const PENDING_STATUSES: ReadonlySet<string> = new Set(["PENDING", "EXTENDED"]);
/** Palm Q4: Awaiting = a PAUSED 1st-trial / 1-hour class (a PAUSED voucher session appears on no card — his open question). */
export const AWAITING_TYPES: ReadonlySet<string> = new Set(["FIRST_TRIAL", "SINGLE_SESSION"]);
/** Palm Q5: Total booked excludes PAUSED (and CANCELLED). */
export const NOT_BOOKED_STATUSES: ReadonlySet<string> = new Set(["CANCELLED", "PAUSED"]);

/** One booking row of the day, already reduced to what the counters need. `coachIds[0]` is the primary coach (`bookings.teacher_id`), the rest are `booking_teachers`. */
export interface ReportRow {
  status: string;
  bookingType: string;
  coachIds: readonly string[];
}

export interface ByType { type: LessonType; count: number }
export interface ByTeacher { teacherId: string; count: number; attended: number; total: number }
export interface DailyReportCounts {
  totalBooked: number;
  attended: number;
  confirmed: number;
  pending: number;
  awaiting: number;
  onLeave: number;
  cancelled: number;
  attendanceRate: number;
  noShow: number; // legacy, kept (harmless; Palm allows it)
  byBookingType: ByType[]; // legacy, kept: the booked lessons per type
  byBookingTypeAttended: ByType[];
  byBookingTypeConfirmed: ByType[];
  byTeacher: ByTeacher[];
}

const isLesson = (r: ReportRow): boolean => (LESSON_TYPES as readonly string[]).includes(r.bookingType);
const isBooked = (r: ReportRow): boolean => !NOT_BOOKED_STATUSES.has(r.status);
const isConfirmed = (r: ReportRow): boolean => CONFIRMED_STATUSES.has(r.status);
const byType = (rows: ReportRow[], pred: (r: ReportRow) => boolean): ByType[] => LESSON_TYPES.map((type) => ({ type, count: rows.filter((r) => r.bookingType === type && pred(r)).length }));

/**
 * The whole report from the day's rows. `teacherId` filters EVERY counter: a row belongs to a coach if he is the primary coach OR one of the extras. `byTeacher` then lists only that coach
 * (declared: the other coaches of a shared row are not this coach's report). `includePending` is the switch above, injectable only so BOTH paths are tested.
 */
export function countDaily(rowsOfDay: readonly ReportRow[], opts: { teacherId?: string; includePending?: boolean } = {}): DailyReportCounts {
  const includePending = opts.includePending ?? TOTAL_BOOKED_INCLUDES_PENDING;
  const rows = opts.teacherId ? rowsOfDay.filter((r) => r.coachIds.includes(opts.teacherId!)) : [...rowsOfDay];
  const lessons = rows.filter(isLesson);
  const n = (pred: (r: ReportRow) => boolean) => lessons.filter(pred).length;

  const attended = n((r) => r.status === "ATTENDED");
  const confirmed = n(isConfirmed);
  const onLeave = n((r) => r.status === "SICK_LEAVE");
  const totalBooked = includePending ? n(isBooked) : confirmed + onLeave;

  // workload: every row that is neither cancelled nor paused (lesson + OTHER incl. camp hour rows + GROUP) adds 1 to `total` of its primary AND each extra coach; `count`/`attended` from lessons only
  const per = new Map<string, ByTeacher>();
  for (const r of rows) {
    if (!isBooked(r)) continue;
    for (const id of new Set(r.coachIds)) {
      if (opts.teacherId && id !== opts.teacherId) continue;
      const t = per.get(id) ?? { teacherId: id, count: 0, attended: 0, total: 0 };
      t.total += 1;
      if (isLesson(r)) {
        if (isConfirmed(r)) t.count += 1;
        if (r.status === "ATTENDED") t.attended += 1;
      }
      per.set(id, t);
    }
  }
  // order: total desc, count desc, then teacherId asc (declared: the stable tie-break)
  const byTeacher = [...per.values()].sort((a, b) => b.total - a.total || b.count - a.count || (a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0));

  return {
    totalBooked,
    attended,
    confirmed,
    pending: n((r) => PENDING_STATUSES.has(r.status)),
    awaiting: n((r) => r.status === "PAUSED" && AWAITING_TYPES.has(r.bookingType)),
    onLeave,
    cancelled: n((r) => r.status === "CANCELLED"),
    attendanceRate: totalBooked > 0 ? Math.round((attended / totalBooked) * 100) : 0,
    noShow: n((r) => r.status === "NO_SHOW"),
    byBookingType: byType(lessons, isBooked),
    byBookingTypeAttended: byType(lessons, (r) => r.status === "ATTENDED"),
    byBookingTypeConfirmed: byType(lessons, isConfirmed),
    byTeacher,
  };
}
