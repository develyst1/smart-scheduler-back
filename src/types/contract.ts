// ─────────────────────────────────────────────────────────────────────────────
// API contract — Scheduling API (frontoffice). Single source of truth for the
// request/response shapes shared with `smart-scheduler-front`.
//
// Design rules (from the product owner):
//  1. Few endpoints — one aggregate read per screen/tab, consolidated mutations.
//  2. Scalable request types — references by id + tagged unions, never bare
//     denormalized strings (e.g. NOT `studentName: string`).
//  3. Ready-to-use responses — names/quotas are pre-joined server-side so the
//     frontend renders directly and never calls N endpoints to stitch data.
// ─────────────────────────────────────────────────────────────────────────────

// ───────────── Scalars / enums (must match the DB enums & FE unions) ─────────────

export type TeacherType = "FULL_TIME" | "PART_TIME" | "FREELANCE";
export type BookingType =
  | "FIRST_TRIAL"
  | "SINGLE_SESSION"
  | "COURSE_PACKAGE"
  | "VOUCHER";
export type BookingStatus =
  | "PENDING"
  | "CONFIRMED"
  | "ATTENDED"
  | "SICK_LEAVE"
  | "EXTENDED"
  | "PENDING_RESCHEDULE" // overbooked → awaiting parent acceptance of the move (B.1)
  | "CANCELLED";
export type PackageSize = 4 | 6 | 10;

/** How the existing booking is moved when a slot is overbooked. */
export type RescheduleReason = "MOVE_DAY" | "MOVE_WEEK" | "MOVE_TEACHER";

/** Where an overbooked booking is proposed to move (pending parent acceptance). */
export interface RescheduleTarget {
  reason: RescheduleReason;
  date: IsoDate;
  teacherId: string;
  startTime: HhMm;
  endTime: HhMm;
}

/** ISO date `YYYY-MM-DD` (local calendar, Asia/Bangkok). */
export type IsoDate = string;
/** `HH:mm`, already trimmed of seconds by the API. */
export type HhMm = string;

// ───────────────────────── Embedded building blocks ─────────────────────────
// These nested objects are what make responses "ready-to-use": every booking
// already carries the teacher/student/subject/course it needs.

export interface StudentRef {
  id: string;
  name: string;
  nickname: string | null;
  /** CRM (C.2) — optional for backward compat */
  crmPoints?: number;
  crmLevel?: number;
  crmLevelName?: string;
  /** UC-020 — สิทธิประโยชน์ตามระดับ (advisory ให้ staff) */
  priorityBooking?: boolean;
  perks?: string[];
}

/** UC-020 — one rung of the CRM ladder (GET /api/crm/levels). */
export interface CrmLevelDTO {
  level: number;
  name: string;
  minPoints: number;
  priorityBooking: boolean;
  perks: string[];
}

export interface SubjectRef {
  id: string;
  name: string;
}

export interface TeacherDTO {
  id: string;
  name: string;
  nickname: string;
  type: TeacherType;
  active: boolean;
  subjects: SubjectRef[];
  /** has a LINE userId — if false, the FE can warn that confirm won't notify. */
  lineLinked: boolean;
  /** 0=Sun … 6=Sat — days this teacher appears on the calendar */
  workDays: number[];
  /** THB/hour = the teacher's EXPENSE item unit price in backoffice (UC-016). null when off. */
  hourlyRate?: number | null;
  /** Hours of monthly work quota left (backoffice EXPENSE item stock). null when none. */
  quotaRemaining?: number | null;
  /** Quota exhausted → the calendar hides this teacher so admins spread the work. */
  overLimit?: boolean;
}

/** Computed course view — the leave/quota math done server-side (authoritative). */

/** SPEC-064 / TASK-188 — the four course lifecycle statuses, in precedence order. */
export type CourseStatus = "CANCELLED" | "COMPLETED" | "EXPIRED" | "ACTIVE";
export interface CourseSummary {
  id: string;
  size: PackageSize;
  usedSessions: number;
  leaveUsed: number;
  leaveQuota: number; // 4→1, 6→2, 10→3
  leaveRemaining: number;
  maxWeek: number; // 4→5, 10→13 (6 TBC with client)
  leaveLocked: boolean; // over quota & not admin-unlocked → no more rescheduling
  adminUnlocked: boolean;
  /** SPEC-064 / TASK-181 (REQ-036) — when the course was ended early, and why. `null` for a live course.
   *  `size` above still reads what the family bought; these say the plan is finished. */
  endedAt: string | null;
  endReason: "PROGRAM_CHANGED" | "CUSTOMER_CANCELLED" | "ADMIN_ERROR" | null;
  /** SPEC-064 / TASK-188 (REQ-036 B3) — the course's lifecycle status, computed server-side with a fixed
   *  precedence (CANCELLED → COMPLETED → EXPIRED → ACTIVE) so every course is exactly one. The badge renders
   *  this and the filter filters on it; neither computes its own, which is what let a cancelled course show a
   *  green `ปกติ`. */
  status: CourseStatus;
  expiryDate: IsoDate;
  /** The course's sport program, derived from its bookings (a course ⇔ one subject). null only when the
   *  course's bookings aren't loaded (e.g. post-mutation responses) — the list re-fetches. (REQ-010) */
  subject: SubjectRef | null;
}

/** The universal booking shape — used by calendar cells, the table, and the modal. */


/**
 * SPEC-063 / TASK-184 — one session as the **entitlement plan** view returns it (`GET /entitlements/:id/plan`).
 *
 * 🔴 This type exists to make `toSessionRow` unable to drop a field again. That mapper was an untyped
 * `(b: any) => ({…})` allow-list, so when TASK-178 added `attendeeNote` to the booking it silently never
 * arrived here — the per-session editor could **save a note it could not show**, which is worse than no
 * editor: staff overwrite what they cannot see. tsc said nothing, because nothing tied the mapper to a shape.
 *
 * That is the fourth compiler-silent allow-list in this feature set (the `createBooking` POST body,
 * `dtoToBooking`, the FE response mapper, and this). A type is the cheapest guard that cannot rot — a test
 * would only cover the fields someone thought to assert.
 *
 * Named `PlanSessionRow` rather than `PlanSession` because `lib/course-plan.ts` already owns that name for the
 * pure planner's input, and two different `PlanSession`s in one codebase is its own trap.
 */
export interface PlanSessionRow {
  id: string;
  date: IsoDate;
  /** As stored (`HH:mm:ss`) — unchanged by TASK-184; the FE formats. */
  startTime: string;
  status: BookingStatus | string;
  /** SPEC-033 — lets the course view flag a soft-linked SINGLE_SESSION extra distinctly. */
  bookingType: BookingType | string;
  teacher: { id: string; name: string; nickname: string | null } | null;
  subject: { id: string; name: string } | null;
  /** SPEC-063 / TASK-178 — the attendee note for this session, or `null`. */
  attendeeNote: string | null;
}
/** A discount as captured on a booking (TASK-171). The `value`'s unit follows `kind`: PERCENT = a percentage,
 *  BAHT = whole baht — never satang, so the wire carries no second unit conversion (TASK-168). */
export interface BookingDiscount {
  kind: "PERCENT" | "BAHT";
  value: number;
  reason: string | null;
  actor: string | null;
}

export interface BookingDTO {
  id: string;
  date: IsoDate;
  startTime: HhMm;
  endTime: HhMm;
  bookingType: BookingType;
  status: BookingStatus;
  note: string | null;
  /** SPEC-063 / TASK-178 (REQ-068) — the attendee note for this session, or `null`. Separate from `note`, which
   *  carries the system's own status reasons. Max 200 chars, set at booking or edited per session. */
  attendeeNote: string | null;
  /** SPEC-045 / TASK-190 (REQ-052) — true when equipment is rented against this session. A **presence marker**
   *  for the calendar cell's fifth toggle item; the rental's detail lives in the ledger, not on a booking. */
  hasRental: boolean;
  student: StudentRef;
  teacher: Pick<TeacherDTO, "id" | "name" | "nickname" | "type">;
  subject: SubjectRef;
  /** present iff bookingType === "COURSE_PACKAGE" — quota context for the modal. */
  course: CourseSummary | null;
  // ── Conflict resolution (B.1) ──
  /** true = a new booking still waiting for this slot (hidden from the grid until the move is confirmed). */
  pendingSlot: boolean;
  /** when status === PENDING_RESCHEDULE: id of the new booking holding this slot. */
  incomingBookingId: string | null;
  /** when status === PENDING_RESCHEDULE: where this booking is proposed to move. */
  rescheduleTo: RescheduleTarget | null;
  /**
   * SPEC-059 / TASK-171 (REQ-063 req 8 / AC-10) — the discount captured when this booking was made, or `null`
   * when there was none. `value` is the HUMAN number as typed: a percentage, or **whole baht** (TASK-168).
   * `actor` is carried for the record; the card shows amount + reason only until per-person logins exist.
   */
  discount: BookingDiscount | null;
}

// ═════════════════════════════ READ responses ═════════════════════════════

/**
 * GET /api/calendar?date=YYYY-MM-DD&view=day|week
 * Flagship aggregate: replaces getTeachers + getBookings(range) + course lookups.
 * Fully composed for direct render — `days[].columns[].slots[]` maps 1:1 to the grid.
 */
export interface CalendarResponse {
  view: "day" | "week";
  range: { from: IsoDate; to: IsoDate };
  timeSlots: HhMm[]; // ["09:00" … "17:00"] (09:00–18:00)
  days: Array<{
    date: IsoDate;
    columns: Array<{
      teacher: TeacherDTO; // active teachers only, priority-sorted (full/part → freelance)
      slots: Array<{ time: HhMm; booking: BookingDTO | null }>; // ordered, length = timeSlots
    }>;
  }>;
}

/**
 * GET /api/teachers
 * Pre-grouped & ordered for the Teachers screen, incl. the group-toggle flag.
 */
export interface TeachersResponse {
  groups: Array<{
    type: TeacherType;
    allActive: boolean; // drives the "ปิด/เปิดทั้งกลุ่ม" button
    teachers: TeacherDTO[];
  }>;
}

/**
 * GET /api/courses
 * Courses + leave-quota tab. Each row carries the student + computed quota.
 */
export type CoursesResponse = Array<CourseSummary & { student: StudentRef }>;

/**
 * POST /api/bookings/bulk-confirm { ids }
 * Confirm many bookings in one call — partial success, no batch rollback (REQ-008 / SPEC-011).
 */
export type BulkConfirmOutcome = "confirmed" | "already_confirmed" | "skipped";
export interface BulkConfirmResult {
  id: string;
  /** confirmed = newly confirmed (LINE queued + budget drawn once); already_confirmed = idempotent no-op;
   *  skipped = not confirmed (`reason` set: over-budget freelance, non-PENDING booking, or not found). */
  outcome: BulkConfirmOutcome;
  reason?: string;
}
export interface BulkConfirmResponse {
  results: BulkConfirmResult[];
}

/**
 * GET /api/bookings?from&to&type&status&teacherId&q&page&limit
 * All-bookings tab — teacher/student/subject embedded, server-filtered + paginated.
 */
export interface BookingsResponse {
  items: BookingDTO[];
  page: number;
  limit: number;
  total: number;
}

/** GET /api/reports/daily?date=YYYY-MM-DD */
export interface DailyReportResponse {
  date: IsoDate;
  totalBooked: number;
  attended: number;
  onLeave: number;
  pending: number;
  cancelled: number;
  byBookingType: Array<{ type: BookingType; count: number }>;
}

// ═════════════════════════════ WRITE requests ═════════════════════════════

/**
 * Scalable student reference. Either an existing id, or an inline new student.
 * This tagged union is the fix for the old `studentName: string` — it keeps the
 * free-text "type a name" UX while enabling dedupe, history, wallet & parent-LINE.
 */
export type StudentInput =
  | { id: string }
  | {
      name: string;
      nickname?: string;
      /** parent phone — the service find-or-creates the guardian and attaches the student. */
      phone?: string;
    };

/**
 * GET /api/students?q=&limit= — booking dropdown source. Each item is searchable
 * by name / nickname / parent phone; `label` is "name (phone)" ready for display.
 */
export interface StudentListItem {
  id: string;
  name: string;
  nickname: string | null;
  phone: string | null; // parent phone
  parentId: string | null;
  parentName: string | null;
  label: string;
}
export type StudentsResponse = StudentListItem[];

/**
 * POST /api/students → 201 — staff creates a student under an existing parent
 * (parentId) OR a phone (find-or-create the parent). Max 5 students per parent.
 */
export interface CreateStudentRequest {
  name: string;
  nickname?: string;
  note?: string;
  parentId?: string;
  parentPhone?: string;
  parentName?: string;
}
export interface CreateStudentResponse {
  student: { id: string; name: string; nickname: string | null; parentId: string | null };
  parent: { id: string; phone: string; name: string | null };
}

/**
 * POST /api/bookings  → 201
 * endTime is derived server-side (+1h); never trust a client-sent end time.
 */
export interface CreateBookingRequest {
  student: StudentInput;
  teacherId: string;
  subjectId: string;
  date: IsoDate;
  startTime: HhMm;
  bookingType: BookingType;
  courseId?: string; // when COURSE_PACKAGE
  voucherId?: string; // when VOUCHER
  note?: string;
}
export interface CreateBookingResponse {
  booking: BookingDTO;
  course: CourseSummary | null;
}

/**
 * PATCH /api/bookings/:id/status
 * One endpoint for every transition (confirm/attend/sick-leave/cancel) WITH its
 * side effects (LINE push on confirm, auto-extend or lock on sick-leave). The
 * response returns everything that changed so the FE updates without refetching.
 */
export type BookingStatusAction = "confirm" | "attend" | "sick-leave" | "cancel";
export interface UpdateBookingStatusRequest {
  action: BookingStatusAction;
  reason?: string;
}
export interface UpdateBookingStatusResponse {
  booking: BookingDTO; // the updated booking
  extended: BookingDTO | null; // auto-created make-up slot (sick-leave within quota)
  course: CourseSummary | null; // updated quota, if course-linked
  locked: boolean; // sick-leave over quota → needs admin unlock
  notification:
    | { channel: "line"; status: "queued" | "skipped"; reason?: string }
    | null; // what happened with LINE, so the toast is accurate
}

/**
 * PATCH /api/bookings/:id — move/edit a booking (manual reschedule).
 * Per requirement.md: staff may MOVE (teacher/date/time) or edit a session by hand
 * for special cases. endTime is re-derived if startTime changes; clashes → 409.
 */
export interface MoveBookingRequest {
  teacherId?: string;
  subjectId?: string;
  date?: IsoDate;
  startTime?: HhMm;
  note?: string;
}
export interface MoveBookingResponse {
  booking: BookingDTO;
}

/**
 * PATCH /api/teachers/availability
 * Single (teacherId) OR whole group (type). Exactly one of the two is provided.
 */
export interface SetAvailabilityRequest {
  teacherId?: string;
  type?: TeacherType;
  active: boolean;
}
export interface SetAvailabilityResponse {
  teachers: TeacherDTO[]; // every affected teacher, ready-to-use
}

/** PATCH /api/teachers/:id/work-days — วันที่ครูมาสอน (0=Sun … 6=Sat) */
export interface SetTeacherWorkDaysRequest {
  workDays: number[];
}
export type SetTeacherWorkDaysResponse = TeacherDTO;

/**
 * PATCH /api/courses/:id  (admin actions; extensible)
 */
export interface UpdateCourseRequest {
  adminUnlocked?: boolean;
}
export type UpdateCourseResponse = CourseSummary & { student: StudentRef };

/**
 * POST /api/courses  → 201 — register a 4/6/10-session course and auto-generate
 * its weekly sessions (B.4). A slot clash on any week rejects the whole request (409).
 */
export interface CreateCoursePackageRequest {
  student: StudentInput;
  teacherId: string;
  subjectId: string;
  size: PackageSize;
  startDate: IsoDate;
  startTime: HhMm;
  note?: string;
}
export interface CreateCoursePackageResponse {
  course: CourseSummary & { student: StudentRef };
  bookings: BookingDTO[]; // the generated weekly sessions, ordered by date
}

/** Voucher = hours bucket; validity starts at first booking (B.5). */
export interface VoucherSummary {
  id: string;
  totalHours: number;
  usedHours: number;
  remaining: number;
  expiryDate: IsoDate;
  student: StudentRef;
}
/** GET /api/vouchers?studentId&q — voucher tab + booking picker source. */
export type VouchersResponse = VoucherSummary[];

/** POST /api/vouchers  → 201 */
export interface CreateVoucherRequest {
  student: StudentInput;
  totalHours: 5 | 10 | 15;
}
export interface CreateVoucherResponse {
  voucher: VoucherSummary;
}

/**
 * GET/PATCH /api/teachers/type-order — persisted global ordering of the 3 teacher
 * types (B.2). Drives calendar column + teacher-group order, server-side authoritative.
 */
export interface TeacherTypeOrderResponse {
  order: TeacherType[];
}
export interface SetTeacherTypeOrderRequest {
  order: TeacherType[];
}

// ═══════════════════════════════ Auth (B.7) ═══════════════════════════════

export type Role = "admin" | "staff";

/** POST /auth/login — staff/admin login (public). */
export interface LoginRequest {
  username: string;
  password: string;
}
export interface LoginResponse {
  token: string;
  user: { username: string; role: Role };
}

// ═══════════════════════════════ Errors ═══════════════════════════════

export type ApiErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UNAUTHORIZED" // 401 — missing/invalid token
  | "SLOT_TAKEN" // 409 — teacher slot already booked
  | "COURSE_EXPIRED"
  | "LEAVE_LOCKED" // attempted to extend past quota without unlock
  | "CONFLICT";

export interface ApiError {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}
