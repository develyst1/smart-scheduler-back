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
}

/** Computed course view — the leave/quota math done server-side (authoritative). */
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
  expiryDate: IsoDate;
}

/** The universal booking shape — used by calendar cells, the table, and the modal. */
export interface BookingDTO {
  id: string;
  date: IsoDate;
  startTime: HhMm;
  endTime: HhMm;
  bookingType: BookingType;
  status: BookingStatus;
  note: string | null;
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
      phone?: string;
      parentLineUserId?: string;
    };

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
 * POST /api/bookings/with-reschedule  → 201
 * Overbook a slot: create the new booking AND move the existing occupant out
 * (pending parent acceptance via LINE). If the slot is actually free, this just
 * creates the booking (existing = null), so the FE can call it optimistically.
 */
export interface CreateBookingWithRescheduleRequest extends CreateBookingRequest {
  resolution: {
    reason: RescheduleReason;
    date: IsoDate;
    teacherId: string;
    startTime: HhMm;
  };
}
export interface CreateBookingWithRescheduleResponse {
  /** the existing booking now PENDING_RESCHEDULE — null when the slot was free. */
  existing: BookingDTO | null;
  /** the newly created booking (pendingSlot when there was a conflict). */
  incoming: BookingDTO;
}

/**
 * PATCH /api/bookings/:id/reschedule/confirm — parent accepted: move the booking
 * to its proposed slot and free this slot for the incoming booking.
 * PATCH /api/bookings/:id/reschedule/cancel  — parent declined: drop the incoming
 * booking and restore this one.
 */
export interface RescheduleDecisionResponse {
  booking: BookingDTO | null;
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
