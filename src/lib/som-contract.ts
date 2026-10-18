// 🔻 TASK-741 (REQ-124) — the PURE counters of `GET /api/reports/som`, Palm's contract (`smart-scheduler-front` → `docs/backend-som-dashboard.md` §0.1, §1, §2, §5, §6). No database, no clock:
// the service reads the rows and hands them here, so every rule below is asserted with values. The OLD `getSomReport` + `lib/som-report.ts` are NOT touched (7 test files pin their text); the route
// MERGES these sections into the old result (`mergeSom`), so every old field the front still reads stays.
//
// Palm's open questions (Q*) and the customer's open conflicts (K*) are answered here with the DEFAULTS of `CHECK-REQ-124` §4 — each one a named constant (or an injectable option) so a ruling is a
// one-line flip + its pin. 🚫 Nothing here "improves" them.
import { countDaily, LESSON_TYPES, type ReportRow } from "./daily-report";
import { courseStatus, type CourseStatus } from "./course-status";
import { ageFrom, breakdown, UNKNOWN_KEY, type Breakdown, type BreakdownBucket } from "./som-report";
import { addDays } from "./time";
import { voucherStatus, type VoucherStatus } from "./voucher";

/** 🔒 K1 (the OWNER's, open) — what an Existing-Customers `activeCourse` / `activeVoucher` card counts: PEOPLE (Palm §2: «นักเรียน 1 คนมี 2 คอร์ส active = +1») or PACKAGES (the meeting paraphrase). Default Palm's. */
export const ACTIVE_COUNT_UNIT: "PEOPLE" | "PACKAGES" = "PEOPLE";
/** 🔒 Q2.2 — a student who bought a VOUCHER after the trial also moves out of «1st Trial»? Default NO: only a COURSE moves a trial out (CHECK §4). */
export const TRIAL_MOVES_OUT_ON_VOUCHER = false;
/** 🔒 Q2.3 — «1 HR» uses the same move-out rule as 1st Trial? Default NO: a 1 HR never moves out (CHECK §4). */
export const SINGLE_SESSION_MOVES_OUT = false;

/** Sessions that consumed the entitlement: `usedSessions` / `usedHours` go up on ATTEND and on the day-end NO_SHOW (CHECK M12). */
export const USED_STATUSES: ReadonlySet<string> = new Set(["ATTENDED", "NO_SHOW"]);

/**
 * 🔒 Q5.1 / K3 (the OWNER's, open) — the 9 age bands, Palm's reading (§5.1), in order, ALWAYS all present. Age 0 (an infant) is filed under `1-2` (declared: a kid never lands in `unknown` for being young).
 * The OLD `AGE_BANDS` in `lib/som-report.ts` stays for the old field.
 */
export const SOM_AGE_BANDS: ReadonlyArray<{ key: string; label?: string; min: number; max: number }> = [
  { key: "1-2", min: 0, max: 2 },
  { key: "3-4", min: 3, max: 4 },
  { key: "5-7", min: 5, max: 7 },
  { key: "8-10", min: 8, max: 10 },
  { key: "11-13", min: 11, max: 13 },
  { key: "14-19", label: "14+", min: 14, max: 19 },
  { key: "20-39", label: "20+", min: 20, max: 39 },
  { key: "40-54", label: "40+", min: 40, max: 54 },
  { key: "55+", min: 55, max: Infinity },
];

// ───────────── dates (Asia/Bangkok, fixed +7, no DST) ─────────────
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
/** The Bangkok calendar date of an instant. */
export const bangkokDate = (when: Date | string): string => new Date(new Date(when).getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
/** `YYYY-MM` + n months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
/** The last day of a `YYYY-MM`, as `YYYY-MM-DD`. */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// ───────────── inputs (the service reduces the rows to these) ─────────────
export interface SomBooking {
  /** The child ids of the row — a DUO row names both (`duoStudentIds`). */
  studentIds: readonly string[];
  bookingType: string;
  status: string;
  date: string;
  subjectId: string | null;
  courseId: string | null;
  voucherId: string | null;
  /** The badge VALUE ids on the row. */
  badgeIds: readonly string[];
  /** 🔻 742 — the primary coach, the extra coaches (`booking_teachers`) and the clock times (Coach Capacity hours, the “first session's teacher”). Optional: 741's counters read none of them. */
  teacherId?: string | null;
  extraTeacherIds?: readonly string[];
  startTime?: string;
  endTime?: string;
  /** A GROUP's seat (`group_id` set): a student's session, but never a row of the DAY's counters (the group row counts once per coach). */
  isSeat: boolean;
}
export interface ExpiryChange { fromDate: string; changedAt: Date | string }
export interface SomCourse {
  id: string;
  studentIds: readonly string[];
  createdAt: Date | string;
  /** 🔻 742 — the course's program (its label «Course 10 · Bike»). */
  subjectId?: string | null;
  size: number;
  usedSessions: number;
  expiryDate: string;
  endedAt: Date | string | null;
  droppedAt: Date | string | null;
  expiryChanges: readonly ExpiryChange[];
}
export interface SomVoucher {
  id: string;
  studentId: string;
  createdAt: Date | string;
  totalHours: number;
  usedHours: number;
  expiryDate: string;
  endedAt: Date | string | null;
  expiryChanges: readonly ExpiryChange[];
}
export interface SomStudent {
  id: string;
  /** 🔻 742 — how a list row names the child: `nickname || name` (the family-print rule). */
  name?: string;
  nickname?: string | null;
  gender: string | null;
  nationality: string | null;
  birthDate: string | null;
  /** The ACTIVE parent's Thai province name (null = no parent / archived household / blank) — the same field the old report breaks down. */
  province: string | null;
  /** The ACTIVE parent's district code (REQ-118, `0069`); null before the admins fill it. */
  districtCode: string | null;
}
export interface SomSubject { id: string; name: string; active: boolean }
export type TeacherType = "FULL_TIME" | "PART_TIME" | "FREELANCE";
/** 🔻 742 — a coach for Coach Capacity. `workDays`: 0 = Sun … 6 = Sat. */
export interface SomTeacher { id: string; nickname?: string; type: TeacherType; active: boolean; archived: boolean; workDays: readonly number[] }

export interface SomContractInput {
  /** `YYYY-MM` — applies to every section except Today. */
  month: string;
  /** Bangkok today. */
  today: string;
  /** OR; empty = every branch. */
  badgeValueIds: readonly string[];
  bookings: readonly SomBooking[];
  courses: readonly SomCourse[];
  vouchers: readonly SomVoucher[];
  students: readonly SomStudent[];
  subjects: readonly SomSubject[];
  /** The label of a district code — `"<district TH>, <province TH>"`, or null when the code is not in the dataset (→ the student is `unknown`). Injected so this file reads no dataset. */
  districtLabel: (code: string) => string | null;
  /** 🔻 742 — the roster and the recorded advance-leave days for Coach Capacity. */
  teachers?: readonly SomTeacher[];
  leaveDays?: ReadonlyArray<{ teacherId: string; date: string }>;
  /** Injectable only so BOTH paths of K1 are tested. */
  activeUnit?: "PEOPLE" | "PACKAGES";
}

export interface SomContractSections {
  today: { date: string; confirmed: number; attended: number; attendanceRate: number };
  existingCustomers: { month: string; activeCourse: number; activeVoucher: number; recentFirstTrial: number; recentSingleSession: number; totalCustomers: number; recentFrom: string; recentTo: string };
  demographics: { month: string; gender: Breakdown; ageBand: Breakdown; nationality: Breakdown; province: Breakdown; district: Breakdown };
  activityProgram: { month: string; categories: ActivityCategory[] };
  newVsRenewing: NvrCounts;
  coachCapacity: CoachCapacity;
}
export interface ActivityCategory { key: string; label: string; course: number; voucher: number; singleSession: number; typeTotal: number; firstTrial: number; total: number }

const isLesson = (b: { bookingType: string }): boolean => (LESSON_TYPES as readonly string[]).includes(b.bookingType);

/**
 * A course's / voucher's lifecycle status AS OF a date (Bangkok `YYYY-MM-DD`; null = not bought yet): the stored counter is not kept per day (CHECK M12), so it is REBUILT — `stored −
 * the delivered rows dated after the date`, the expiry IN FORCE that day (the `from` of the first expiry move made AFTER it), and an end / pause made after it is ignored. The ONE definition
 * Existing Customers (741) and New vs Renewing (742) both read. Known limit: a pause that was later RESUMED leaves no trace (`dropped_at` is cleared).
 */
export function entitlementClock(bookings: readonly SomBooking[]) {
  const usedAfter = (entitlementId: string, key: "courseId" | "voucherId", date: string): number =>
    bookings.filter((b) => b[key] === entitlementId && USED_STATUSES.has(b.status) && b.date > date).length;
  const expiryAt = (current: string, changes: readonly ExpiryChange[], date: string): string => {
    const later = changes.filter((c) => bangkokDate(c.changedAt) > date).sort((a, b) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime());
    return later[0]?.fromDate ?? current;
  };
  const stillThen = (when: Date | string | null, date: string): Date | string | null => (when != null && bangkokDate(when) <= date ? when : null);
  return {
    courseStatus: (c: SomCourse, date: string): CourseStatus | null =>
      bangkokDate(c.createdAt) > date // not bought yet
        ? null
        : courseStatus(
            { size: c.size, usedSessions: Math.max(0, c.usedSessions - usedAfter(c.id, "courseId", date)), expiryDate: expiryAt(c.expiryDate, c.expiryChanges, date), endedAt: stillThen(c.endedAt, date), droppedAt: stillThen(c.droppedAt, date) },
            date,
          ),
    voucherStatus: (v: SomVoucher, date: string): VoucherStatus | null =>
      bangkokDate(v.createdAt) > date
        ? null
        : voucherStatus({ totalHours: v.totalHours, usedHours: Math.max(0, v.usedHours - usedAfter(v.id, "voucherId", date)), expiryDate: expiryAt(v.expiryDate, v.expiryChanges, date), endedAt: stillThen(v.endedAt, date) }, date),
  };
}

export function countSom(input: SomContractInput): SomContractSections {
  const { month, today, bookings, courses, vouchers, subjects } = input;
  const unit = input.activeUnit ?? ACTIVE_COUNT_UNIT;
  const badges = new Set(input.badgeValueIds);
  /** §0.1 — a booking matches when it carries ANY selected badge (OR); no badge selected = every branch. */
  const passes = (b: SomBooking): boolean => badges.size === 0 || b.badgeIds.some((id) => badges.has(id));

  const monthFrom = `${month}-01`;
  const monthTo = monthEnd(month);
  const recentFrom = addMonths(month, -2);
  const recentFromDate = `${recentFrom}-01`;
  /** «Active at month end»; the current month = today (CHECK Q2.6). */
  const asOf = today.slice(0, 7) === month ? today : monthTo;
  const inMonth = (d: string) => d >= monthFrom && d <= monthTo;

  // ── Today — REQ-119's counters, verbatim, badge-filtered; `month` is ignored ──
  const dayRows: ReportRow[] = bookings
    .filter((b) => b.date === today && !b.isSeat && passes(b))
    .map((b) => ({ status: b.status, bookingType: b.bookingType, coachIds: [] }));
  const day = countDaily(dayRows);
  // Palm §1 / her sheet (Silver's review 1): the rate is attended ÷ CONFIRMED (not the Daily Report's circle, which divides by confirmed + on leave); confirmed = 0 → 0.
  const todaySection = { date: today, confirmed: day.confirmed, attended: day.attended, attendanceRate: day.confirmed > 0 ? Math.round((day.attended / day.confirmed) * 100) : 0 };

  // ── Existing customers ──
  // A course / voucher is «in a branch» only through its session rows (CHECK M5): any of its non-cancelled rows carries a selected badge.
  const rowsOfEntitlement = new Map<string, SomBooking[]>();
  for (const b of bookings) {
    if (b.status === "CANCELLED") continue;
    const id = b.courseId ?? b.voucherId;
    if (!id) continue;
    const list = rowsOfEntitlement.get(id) ?? [];
    list.push(b);
    rowsOfEntitlement.set(id, list);
  }
  const inBranch = (entitlementId: string): boolean => badges.size === 0 || (rowsOfEntitlement.get(entitlementId) ?? []).some(passes);

  const at = entitlementClock(bookings);
  const activeCourses = courses.filter((c) => at.courseStatus(c, asOf) === "ACTIVE" && inBranch(c.id));
  const activeVouchers = vouchers.filter((v) => at.voucherStatus(v, asOf) === "ACTIVE" && inBranch(v.id));
  const courseHolders = new Set(activeCourses.flatMap((c) => [...c.studentIds]));
  const voucherHolders = new Set(activeVouchers.map((v) => v.studentId));

  /** 🔻 TEST-109 N1 — has this student BOUGHT a course (or, switch-gated, a voucher) no later than `asOf`, WHATEVER THE ORDER with his trial? A child who already holds a course is a course customer and leaves
   *  the trial box even when the course was sold before the trial was booked (or imported). A purchase counts whatever became of it. */
  const boughtByAsOf = (studentId: string, withVouchers: boolean): boolean =>
    courses.some((c) => c.studentIds.includes(studentId) && bangkokDate(c.createdAt) <= asOf) ||
    (withVouchers && vouchers.some((v) => v.studentId === studentId && bangkokDate(v.createdAt) <= asOf));

  /** The students with a non-cancelled class of `type` dated in [from, to] (class date, Q2.4), and each one's EARLIEST such date. */
  const classesIn = (type: string, from: string, to: string): Map<string, string> => {
    const earliest = new Map<string, string>();
    for (const b of bookings) {
      if (b.bookingType !== type || b.status === "CANCELLED" || b.date < from || b.date > to || !passes(b)) continue;
      for (const id of b.studentIds) if (!earliest.has(id) || b.date < earliest.get(id)!) earliest.set(id, b.date);
    }
    return earliest;
  };
  const trialsRecent = classesIn("FIRST_TRIAL", recentFromDate, monthTo);
  const singlesRecent = classesIn("SINGLE_SESSION", recentFromDate, monthTo);
  const recentFirstTrial = [...trialsRecent].filter(([id]) => !boughtByAsOf(id, TRIAL_MOVES_OUT_ON_VOUCHER)).length;
  const recentSingleSession = [...singlesRecent].filter(([id]) => !SINGLE_SESSION_MOVES_OUT || !boughtByAsOf(id, TRIAL_MOVES_OUT_ON_VOUCHER)).length;
  // Total = the distinct names of Active Course + Active Voucher at month end + 1st Trial + 1 HR of the SELECTED month only (Q2.7 — Palm's reading).
  const totalCustomers = new Set([...courseHolders, ...voucherHolders, ...classesIn("FIRST_TRIAL", monthFrom, monthTo).keys(), ...classesIn("SINGLE_SESSION", monthFrom, monthTo).keys()]).size;
  const existingCustomers = {
    month,
    activeCourse: unit === "PEOPLE" ? courseHolders.size : activeCourses.length,
    activeVoucher: unit === "PEOPLE" ? voucherHolders.size : activeVouchers.length,
    recentFirstTrial,
    recentSingleSession,
    totalCustomers,
    recentFrom,
    recentTo: month,
  };

  // ── Attended lessons of the month (Q5.2 / Q6.1): ATTENDED only, the four lesson types, badge-filtered. A GROUP's SEAT is a student's session and counts; the group row itself is not a lesson type. ──
  const attended = bookings.filter((b) => isLesson(b) && b.status === "ATTENDED" && inMonth(b.date) && passes(b));

  // ── Demographics — each student ONCE (any qualifying attended session of the month matches) ──
  const studentById = new Map(input.students.map((s) => [s.id, s]));
  const people = [...new Set(attended.flatMap((b) => [...b.studentIds]))].map((id) => studentById.get(id)).filter((s): s is SomStudent => !!s);
  const labelOfDistrict = new Map<string, string | null>();
  const districtKey = (s: SomStudent): string | null => {
    if (!s.districtCode) return null;
    if (!labelOfDistrict.has(s.districtCode)) labelOfDistrict.set(s.districtCode, input.districtLabel(s.districtCode));
    return labelOfDistrict.get(s.districtCode) ? s.districtCode : null; // a code outside the dataset is unknown, never a bucket with no name
  };
  const demographics = {
    month,
    gender: breakdown(people, (s) => s.gender),
    ageBand: ageBreakdown(people, today),
    nationality: breakdown(people, (s) => s.nationality),
    province: breakdown(people, (s) => s.province),
    district: breakdown(people, districtKey, (key) => labelOfDistrict.get(key) ?? undefined),
  };

  // ── Activity / Program — attended SESSIONS (rows, Q6.8) of the month by each session's subject (a voucher session takes its booking's subject, M8) ──
  const cats = new Map<string, ActivityCategory>();
  const catOf = (key: string, label: string): ActivityCategory => {
    const c = cats.get(key) ?? { key, label, course: 0, voucher: 0, singleSession: 0, typeTotal: 0, firstTrial: 0, total: 0 };
    cats.set(key, c);
    return c;
  };
  for (const s of subjects) if (s.active) catOf(s.id, s.name); // every ACTIVE subject, 0 included
  const nameOf = new Map(subjects.map((s) => [s.id, s.name]));
  for (const b of attended) {
    const c = b.subjectId && nameOf.has(b.subjectId) ? catOf(b.subjectId, nameOf.get(b.subjectId)!) : catOf(UNKNOWN_KEY, "ไม่ระบุ");
    if (b.bookingType === "COURSE_PACKAGE") c.course += 1;
    else if (b.bookingType === "VOUCHER") c.voucher += 1;
    else if (b.bookingType === "SINGLE_SESSION") c.singleSession += 1;
    else if (b.bookingType === "FIRST_TRIAL") c.firstTrial += 1;
  }
  const categories = [...cats.values()]
    .map((c) => ({ ...c, typeTotal: c.course + c.voucher + c.singleSession, total: c.course + c.voucher + c.singleSession + c.firstTrial }))
    // total desc, then the name, then the key (stable); `unknown` is always last, and only present when it has sessions
    .filter((c) => c.key !== UNKNOWN_KEY || c.total > 0)
    .sort((a, b) => (a.key === UNKNOWN_KEY ? 1 : 0) - (b.key === UNKNOWN_KEY ? 1 : 0) || b.total - a.total || a.label.localeCompare(b.label) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { today: todaySection, existingCustomers, demographics, activityProgram: { month, categories }, newVsRenewing: countNvr(input).counts, coachCapacity: countCapacity(input) };
}

/** The 9 bands, ALL always present and in order (zeros kept), then `unknown` (no / invalid DOB). */
function ageBreakdown(people: readonly SomStudent[], today: string): Breakdown {
  const counts = new Map<string, number>(SOM_AGE_BANDS.map((b) => [b.key, 0]));
  let unknown = 0;
  for (const s of people) {
    const age = ageFrom(s.birthDate, today);
    const band = age === null ? undefined : SOM_AGE_BANDS.find((b) => age >= b.min && age <= b.max);
    if (!band) unknown += 1;
    else counts.set(band.key, counts.get(band.key)! + 1);
  }
  const buckets: BreakdownBucket[] = SOM_AGE_BANDS.map((b) => ({ key: b.key, ...(b.label ? { label: b.label } : {}), count: counts.get(b.key)! }));
  buckets.push({ key: UNKNOWN_KEY, label: "ไม่ระบุ", count: unknown });
  return { buckets, known: people.length - unknown, unknown, total: people.length };
}

/** The route's merge: the OLD result stays whole; each new section is laid over the old one of the same name (the new field wins, the old ones the front still reads stay). */
export function mergeSom<O extends { today: object; existingCustomers: object; demographics: object; newVsRenewing: object }>(old: O, fresh: SomContractSections) {
  return {
    ...old,
    today: { ...old.today, ...fresh.today },
    existingCustomers: { ...old.existingCustomers, ...fresh.existingCustomers },
    demographics: { ...old.demographics, ...fresh.demographics },
    newVsRenewing: { ...old.newVsRenewing, ...fresh.newVsRenewing }, // 🔻 742 — the old `newByFirstTrial` / `newByRegistration` / `renewing` (still 0) stay beside Palm's six
    coachCapacity: fresh.coachCapacity,
    activityProgram: fresh.activityProgram,
  };
}

// ═════════════════════════ 🔻 TASK-742 (REQ-124 2/3) — New vs Renewing + Coach Capacity ═════════════════════════

/** The six cards, in Palm's order; each is also the `:bucket` of the list endpoint. */
export const NVR_BUCKETS = ["firstTrial", "newCourseThisMonth", "newCoursePrevMonth", "renewCourse", "trialNotConverted", "notRenewed"] as const;
export type NvrBucket = (typeof NVR_BUCKETS)[number];
export type NvrCounts = { month: string } & Record<NvrBucket, number>;
/** Palm §3.2 — `remark` is `null` until K5 (the admin-typed reason) is built. */
export interface NvrDetailRow {
  studentId: string;
  studentName: string;
  packageLabel: string | null;
  courseTeacherId: string | null;
  trialTeacherId: string | null;
  trialDate: string | null;
  date: string | null;
  remark: null;
}

/** 🔒 Q3.7 — «the earlier course has ENDED» = it is CANCELLED (ended early), COMPLETED (used up) or EXPIRED. A PAUSED course (DROPPED) is not ended: the family is away, not finished (`lib/course-status.ts`). */
export const RENEW_ENDED_STATUSES: ReadonlySet<string> = new Set(["CANCELLED", "COMPLETED", "EXPIRED"]);

const nameOfIds = (students: ReadonlyMap<string, SomStudent>, ids: readonly string[]): string =>
  ids.map((id) => { const s = students.get(id); return (s?.nickname || s?.name || id); }).join(" & ");

/**
 * The six cards AND their lists from ONE function: a card's number is `rows.length`, so the two can never disagree (Palm §3.2). Every rule is inferred from student + dates — no trial→course
 * link and no course→renewal link is stored (CHECK M13). Dates are Bangkok calendar days; «buying» = the Bangkok day of `created_at` (Q3.5).
 */
export function countNvr(input: SomContractInput): { counts: NvrCounts; rows: Record<NvrBucket, NvrDetailRow[]> } {
  const { month, today, bookings, courses, vouchers } = input;
  const badges = new Set(input.badgeValueIds);
  const passes = (b: SomBooking): boolean => badges.size === 0 || b.badgeIds.some((id) => badges.has(id));
  const students = new Map(input.students.map((s) => [s.id, s]));
  const subjectName = new Map(input.subjects.map((s) => [s.id, s.name]));
  const at = entitlementClock(bookings);
  const prevMonth = addMonths(month, -1);

  // a course / voucher is «in a branch» only through its (non-cancelled) session rows (CHECK M5)
  const rowsOf = new Map<string, SomBooking[]>();
  for (const b of bookings) {
    if (b.status === "CANCELLED") continue;
    const id = b.courseId ?? b.voucherId;
    if (id) rowsOf.set(id, [...(rowsOf.get(id) ?? []), b]);
  }
  const inBranch = (id: string): boolean => badges.size === 0 || (rowsOf.get(id) ?? []).some(passes);
  /** The coach of the pack's FIRST session (date, then start time; a cancelled row is not a session). */
  const firstTeacher = (id: string): string | null => {
    const first = [...(rowsOf.get(id) ?? [])].filter((b) => b.teacherId).sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? ""))[0];
    return first?.teacherId ?? null;
  };
  /** The date of the latest delivered row of a pack. */
  const lastDelivered = (id: string, key: "courseId" | "voucherId"): string | null =>
    bookings.filter((b) => b[key] === id && USED_STATUSES.has(b.status)).map((b) => b.date).sort().pop() ?? null;

  // a child's 1st Trial = their EARLIEST non-cancelled FIRST_TRIAL class (class date, CHECK K2); its own badge decides the branch
  const trialOf = new Map<string, { date: string; teacherId: string | null; passes: boolean }>();
  for (const b of [...bookings].sort((x, y) => x.date.localeCompare(y.date) || (x.startTime ?? "").localeCompare(y.startTime ?? ""))) {
    if (b.bookingType !== "FIRST_TRIAL" || b.status === "CANCELLED") continue;
    for (const id of b.studentIds) if (!trialOf.has(id)) trialOf.set(id, { date: b.date, teacherId: b.teacherId ?? null, passes: passes(b) });
  }
  const buyDay = (x: { createdAt: Date | string }): string => bangkokDate(x.createdAt);
  const courseLabel = (c: SomCourse): string => `Course ${c.size}${c.subjectId && subjectName.has(c.subjectId) ? ` · ${subjectName.get(c.subjectId)}` : ""}`;
  const voucherLabel = (v: SomVoucher): string => `Voucher ${v.totalHours} hrs`;
  const row = (o: Partial<NvrDetailRow> & { studentIds: readonly string[] }): NvrDetailRow => ({
    studentId: o.studentIds[0]!,
    studentName: nameOfIds(students, o.studentIds),
    packageLabel: o.packageLabel ?? null,
    courseTeacherId: o.courseTeacherId ?? null,
    trialTeacherId: o.trialTeacherId ?? null,
    trialDate: o.trialDate ?? null,
    date: o.date ?? null,
    remark: null,
  });

  // ── 1st Trial / 1st Trial, no course: people with a trial class this month ──
  const firstTrial: NvrDetailRow[] = [];
  const trialNotConverted: NvrDetailRow[] = [];
  for (const [id, t] of trialOf) {
    if (t.date.slice(0, 7) !== month || !t.passes) continue;
    const r = row({ studentIds: [id], trialDate: t.date, trialTeacherId: t.teacherId });
    firstTrial.push(r); // stays counted even after a course (§3)
    // Q3.4 — a VOUCHER is not a course: only a COURSE converts it. 🔻 TEST-109 N1 — ANY course bought no later than the month end, whatever its order with the trial (the same rule as Existing Customers' 1st Trial card)
    if (!courses.some((c) => c.studentIds.includes(id) && buyDay(c) <= monthEnd(month))) trialNotConverted.push(r);
  }

  // ── packs: how each purchase classifies (inferred from the student's EARLIER purchases) ──
  const earlierCourses = (ids: readonly string[], day: string, except?: SomCourse): SomCourse[] =>
    courses.filter((o) => o !== except && o.studentIds.some((id) => ids.includes(id)) && buyDay(o) < day); // strictly an earlier DAY: two courses bought together are both «first»
  const kindOf = (ids: readonly string[], day: string, except?: SomCourse): "NEW" | "RENEW" | "NEITHER" => {
    const earlier = earlierCourses(ids, day, except);
    if (earlier.length === 0) return "NEW";
    return earlier.every((o) => RENEW_ENDED_STATUSES.has(at.courseStatus(o, day) ?? "")) ? "RENEW" : "NEITHER";
  };

  const newCourseThisMonth: NvrDetailRow[] = [];
  const newCoursePrevMonth: NvrDetailRow[] = [];
  const renewCourse: NvrDetailRow[] = [];
  for (const c of courses) {
    const day = buyDay(c);
    const kind = kindOf(c.studentIds, day, c);
    if (kind === "NEITHER" || !inBranch(c.id)) continue;
    if (kind === "RENEW") {
      if (day.slice(0, 7) === month) renewCourse.push(row({ studentIds: c.studentIds, packageLabel: courseLabel(c), courseTeacherId: firstTeacher(c.id), date: day }));
      continue;
    }
    // NEW course: counted in the month of the child's 1st Trial when they came from one (a trial BEFORE the purchase), else the month it was bought
    const trial = c.studentIds.map((id) => trialOf.get(id)).filter((t): t is NonNullable<typeof t> => !!t && t.date <= day).sort((a, b) => a.date.localeCompare(b.date))[0];
    const assigned = trial ? trial.date.slice(0, 7) : day.slice(0, 7);
    const r = row({ studentIds: c.studentIds, packageLabel: courseLabel(c), courseTeacherId: firstTeacher(c.id), trialTeacherId: trial?.teacherId ?? null, trialDate: trial?.date ?? null, date: day });
    if (assigned === month) newCourseThisMonth.push(r);
    else if (trial && assigned === prevMonth) newCoursePrevMonth.push(r); // «previous month» is a TRIAL month only
  }
  for (const v of vouchers) {
    const day = buyDay(v);
    if (day.slice(0, 7) !== month || !inBranch(v.id) || kindOf([v.studentId], day) !== "RENEW") continue; // a voucher is never «new»; it renews a child whose courses have all ended
    renewCourse.push(row({ studentIds: [v.studentId], packageLabel: voucherLabel(v), courseTeacherId: firstTeacher(v.id), date: day }));
  }

  // ── Course / Voucher not renewed: ENDED this month, and nothing newer bought yet (live: a later renewal removes it, Q3.6) ──
  const notRenewed: NvrDetailRow[] = [];
  const renewedLater = (ids: readonly string[], day: string): boolean =>
    courses.some((o) => o.studentIds.some((id) => ids.includes(id)) && buyDay(o) > day) || vouchers.some((o) => ids.includes(o.studentId) && buyDay(o) > day);
  const consider = (ids: readonly string[], id: string, endDay: string | null, boughtDay: string, label: string) => {
    if (!endDay || !inBranch(id)) return;
    const from = addDays(endDay, 1); // counted from the day AFTER the end (Q3.3)
    if (from.slice(0, 7) !== month || from > today || renewedLater(ids, boughtDay)) return;
    notRenewed.push(row({ studentIds: ids, packageLabel: label, courseTeacherId: firstTeacher(id), date: endDay }));
  };
  for (const c of courses) {
    const st = at.courseStatus(c, today);
    const endDay = st === "CANCELLED" && c.endedAt ? bangkokDate(c.endedAt) : st === "COMPLETED" ? (lastDelivered(c.id, "courseId") ?? buyDay(c)) : st === "EXPIRED" ? c.expiryDate : null;
    consider(c.studentIds, c.id, endDay, buyDay(c), courseLabel(c));
  }
  for (const v of vouchers) {
    const st = at.voucherStatus(v, today);
    const endDay = st === "ENDED" && v.endedAt ? bangkokDate(v.endedAt) : st === "EXHAUSTED" ? (lastDelivered(v.id, "voucherId") ?? buyDay(v)) : st === "EXPIRED" ? v.expiryDate : null;
    consider([v.studentId], v.id, endDay, buyDay(v), voucherLabel(v));
  }

  const order = (a: NvrDetailRow, b: NvrDetailRow) => (a.date ?? a.trialDate ?? "").localeCompare(b.date ?? b.trialDate ?? "") || a.studentName.localeCompare(b.studentName) || a.studentId.localeCompare(b.studentId) || (a.packageLabel ?? "").localeCompare(b.packageLabel ?? "");
  const rows = { firstTrial, newCourseThisMonth, newCoursePrevMonth, renewCourse, trialNotConverted, notRenewed };
  for (const k of NVR_BUCKETS) rows[k].sort(order);
  return {
    rows,
    counts: { month, firstTrial: firstTrial.length, newCourseThisMonth: newCourseThisMonth.length, newCoursePrevMonth: newCoursePrevMonth.length, renewCourse: renewCourse.length, trialNotConverted: trialNotConverted.length, notRenewed: notRenewed.length },
  };
}

// ───────────── Coach Capacity (Palm §4) ─────────────
/** One working day = 09:00–18:00 = nine one-hour slots (`lib/time.ts`). */
export const CAPACITY_HOURS_PER_DAY = 9;
/** 🔒 Q4.5 — the statuses that do NOT count as booked hours (Palm: «not CANCELLED»; PENDING and PAUSED rows still hold the coach's hour). */
export const CAPACITY_NOT_COUNTED_STATUSES: ReadonlySet<string> = new Set(["CANCELLED"]);
/** Palm's contract: a percentage is 0–100. Hours stay raw, so an over-booked coach still shows his real hours. */
export const CAPACITY_PCT_CAP = 100;
export const TEACHER_TYPE_ORDER: readonly TeacherType[] = ["FULL_TIME", "PART_TIME", "FREELANCE"];

export interface CapacityHours {
  bookedHours: number; availableHours: number;
  weekdayBookedHours: number; weekdayAvailableHours: number; weekdayPct: number;
  weekendBookedHours: number; weekendAvailableHours: number; weekendPct: number;
}
export interface CoachCapacity {
  month: string;
  byPerson: Array<{ teacherId: string; teacherType: TeacherType } & CapacityHours>;
  byType: Array<{ teacherType: TeacherType; coaches: number } & CapacityHours>;
}
const pct = (booked: number, available: number): number => (available > 0 ? Math.min(CAPACITY_PCT_CAP, Math.round((booked / available) * 100)) : 0);
const hoursOf = (wd: { b: number; a: number }, we: { b: number; a: number }): CapacityHours => ({
  bookedHours: wd.b + we.b, availableHours: wd.a + we.a,
  weekdayBookedHours: wd.b, weekdayAvailableHours: wd.a, weekdayPct: pct(wd.b, wd.a),
  weekendBookedHours: we.b, weekendAvailableHours: we.a, weekendPct: pct(we.b, we.a),
});
/** 0 = Sun … 6 = Sat of a `YYYY-MM-DD`; Sat / Sun are the weekend. */
const dayOfWeek = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();
const isWeekend = (date: string): boolean => dayOfWeek(date) === 0 || dayOfWeek(date) === 6;
const minutesOf = (b: SomBooking): number => {
  const [sh, sm] = (b.startTime ?? "00:00").split(":").map(Number) as [number, number];
  const [eh, em] = (b.endTime ?? "00:00").split(":").map(Number) as [number, number];
  return Math.max(0, eh * 60 + em - (sh * 60 + sm));
};

export function countCapacity(input: SomContractInput): CoachCapacity {
  const { month } = input;
  const badges = new Set(input.badgeValueIds);
  const passes = (b: SomBooking): boolean => badges.size === 0 || b.badgeIds.some((id) => badges.has(id));
  const days: string[] = [];
  for (let d = `${month}-01`; d <= monthEnd(month); d = addDays(d, 1)) days.push(d);
  const leave = new Set((input.leaveDays ?? []).map((l) => `${l.teacherId}|${l.date}`));
  // Q4.6: the ACTIVE, non-archived coaches. Q4.3: the whole calendar month.
  const coaches = (input.teachers ?? []).filter((t) => t.active && !t.archived);

  // booked MINUTES per coach, split weekday / weekend: lessons + the GROUP row (never its seats, never ECA / camp), badge-filtered (Q0.2: booked only), an extra coach counts too
  const minutes = new Map<string, { wd: number; we: number }>();
  for (const b of input.bookings) {
    if (b.isSeat || CAPACITY_NOT_COUNTED_STATUSES.has(b.status) || !(isLesson(b) || b.bookingType === "GROUP") || b.date < `${month}-01` || b.date > monthEnd(month) || !passes(b)) continue;
    for (const id of new Set([b.teacherId, ...(b.extraTeacherIds ?? [])].filter((x): x is string => !!x))) {
      const m = minutes.get(id) ?? { wd: 0, we: 0 };
      if (isWeekend(b.date)) m.we += minutesOf(b); else m.wd += minutesOf(b);
      minutes.set(id, m);
    }
  }

  const people = coaches.map((t) => {
    const wd = { b: Math.round((minutes.get(t.id)?.wd ?? 0) / 60), a: 0 };
    const we = { b: Math.round((minutes.get(t.id)?.we ?? 0) / 60), a: 0 };
    for (const d of days) {
      if (!t.workDays.includes(dayOfWeek(d)) || leave.has(`${t.id}|${d}`)) continue;
      if (isWeekend(d)) we.a += CAPACITY_HOURS_PER_DAY; else wd.a += CAPACITY_HOURS_PER_DAY;
    }
    return { t, wd, we };
  });
  const byPerson = people
    .sort((x, y) => TEACHER_TYPE_ORDER.indexOf(x.t.type) - TEACHER_TYPE_ORDER.indexOf(y.t.type) || (x.t.nickname ?? "").localeCompare(y.t.nickname ?? "") || (x.t.id < y.t.id ? -1 : x.t.id > y.t.id ? 1 : 0))
    .map(({ t, wd, we }) => ({ teacherId: t.id, teacherType: t.type, ...hoursOf(wd, we) }));
  // by type: the SUM of its coaches' hours, the % computed from the sums (never an average of percentages); always all three rows
  const byType = TEACHER_TYPE_ORDER.map((teacherType) => {
    const mine = byPerson.filter((p) => p.teacherType === teacherType);
    const sum = (k: "weekdayBookedHours" | "weekdayAvailableHours" | "weekendBookedHours" | "weekendAvailableHours") => mine.reduce((s, p) => s + p[k], 0);
    return { teacherType, coaches: mine.length, ...hoursOf({ b: sum("weekdayBookedHours"), a: sum("weekdayAvailableHours") }, { b: sum("weekendBookedHours"), a: sum("weekendAvailableHours") }) };
  });
  return { month, byPerson, byType };
}
