import { z } from "zod";
import { BADGE_COLORS } from "./lib/badge-colors";
import { isRentalCode } from "./lib/sale-items";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ต้องเป็นรูปแบบ YYYY-MM-DD");
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "ต้องเป็นรูปแบบ HH:mm");
const ID = z.string().uuid();

const BOOKING_TYPE = z.enum([
  "FIRST_TRIAL",
  "SINGLE_SESSION",
  "COURSE_PACKAGE",
  "VOUCHER",
]);
const BOOKING_STATUS = z.enum([
  "PENDING",
  "CONFIRMED",
  "ATTENDED",
  "SICK_LEAVE",
  "EXTENDED",
  "PENDING_RESCHEDULE",
  "CANCELLED",
]);
const TEACHER_TYPE = z.enum(["FULL_TIME", "PART_TIME", "FREELANCE"]);

export const calendarQuery = z.object({
  date: DATE,
  view: z.enum(["day", "week"]).default("day"),
});

export const reportQuery = z.object({ date: DATE });

// Booking dropdown: search students by name / nickname / parent phone.
export const studentsQuery = z.object({
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // TASK-058 retired the `bookable` opt-in — suspended households are now excluded by default for every
  // consumer. Zod strips unknown keys, so an older client still sending `bookable=true` is simply ignored
  // (it asked for the behaviour that is now the default), which is what makes the FE/BE deploy order free.
});

// Staff student creation — under an existing parent (parentId) or a phone
// (find-or-create the parent). At most 5 students per parent (enforced in service).
export const createStudent = z
  .object({
    name: z.string().trim().min(1),
    nickname: z.string().trim().optional(),
    note: z.string().trim().optional(),
    parentId: ID.optional(),
    parentPhone: z.string().trim().optional(),
    parentName: z.string().trim().optional(),
  })
  .refine((d) => !!d.parentId || !!d.parentPhone, {
    message: "ต้องระบุ parentId หรือ parentPhone",
  });

export const bookingsQuery = z.object({
  from: DATE.optional(),
  to: DATE.optional(),
  type: BOOKING_TYPE.optional(),
  status: BOOKING_STATUS.optional(),
  teacherId: ID.optional(),
  q: z.string().trim().min(1).optional(),
  // TASK-073. `upcoming` = today/future soonest-first, then the past most-recent-first. An unknown value is a
  // clean 400 from the enum — never a silent fallback to some other order.
  sort: z.enum(["upcoming", "date_asc", "date_desc"]).default("upcoming"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// scalable student reference: existing id OR an inline new student. An inline
// student may carry the parent phone — the service find-or-creates the parent.
const studentInput = z.union([
  z.object({ id: ID }),
  z.object({
    name: z.string().trim().min(1),
    nickname: z.string().trim().optional(),
    phone: z.string().trim().optional(),
  }),
]);

export const createBooking = z
  .object({
    student: studentInput,
    teacherId: ID,
    subjectId: ID,
    date: DATE,
    startTime: TIME,
    bookingType: BOOKING_TYPE,
    courseId: ID.optional(),
    voucherId: ID.optional(),
    note: z.string().optional(),
    // Optional badge value ids to tag the new booking (≤ 1 per badge type; enforced in service).
    badgeValueIds: z.array(ID).optional(),
  })
  // การจองแบบ Voucher ต้องผูกวอยเชอร์เสมอ (ไม่งั้นชั่วโมงจะไม่ถูกตัด)
  .refine((d) => d.bookingType !== "VOUCHER" || !!d.voucherId, {
    message: "การจองแบบ Voucher ต้องเลือกวอยเชอร์ (voucherId)",
    path: ["voucherId"],
  })
  // TASK-055 — symmetric backstop: การจองแบบคอร์สต้องผูกคอร์สเสมอ (ไม่งั้นครั้งเรียนจะไม่ถูกตัด ทั้งตอนเช็คอิน
  // และตอนตัดรอบสิ้นวัน → กลายเป็นคาบฟรี และยอดคงเหลือของคอร์สจะเพี้ยน)
  .refine((d) => d.bookingType !== "COURSE_PACKAGE" || !!d.courseId, {
    message: "การจองแบบคอร์สต้องเลือกคอร์ส (courseId)",
    path: ["courseId"],
  });

// รายการวอยเชอร์ (GET /api/vouchers) — กรองตามนักเรียน/ค้นหาชื่อได้
// Courses/vouchers tabs (TASK-070) — same q/page/limit shape as `bookingsQuery`, so the FE ends up with one
// pagination component instead of three.
export const vouchersQuery = z.object({
  studentId: ID.optional(),
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const coursesQuery = z.object({
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Register a recurring course package (B.4): size + first slot → weekly sessions.
export const createCoursePackage = z
  .object({
    student: studentInput,
    teacherId: ID,
    subjectId: ID,
    size: z.union([z.literal(4), z.literal(6), z.literal(10)]),
    startDate: DATE,
    startTime: TIME,
    note: z.string().optional(),
    // TASK-095 — optional per-session overrides (purchase-time planner). Absent ⇒ the uniform weekly chain.
    sessions: z
      .array(
        z.object({
          date: DATE,
          startTime: TIME.optional(),
          teacherId: ID.optional(),
          subjectId: ID.optional(),
        }),
      )
      .optional(),
  })
  .refine((d) => !d.sessions || d.sessions.length === d.size, {
    message: "จำนวนคาบต้องเท่ากับขนาดคอร์ส",
  })
  // SPEC-045 / TASK-138 (REQ-054): a course is ONE program. A per-row override may repeat the course subject
  // but never introduce a second one — otherwise the course is born mixed-program (the hole TASK-134 closed
  // for edits).
  .refine((d) => !d.sessions || d.sessions.every((s) => !s.subjectId || s.subjectId === d.subjectId), {
    message: "ทุกคาบในคอร์สต้องเป็นกิจกรรมเดียวกัน",
  });

// TASK-095 — generate the editable `size`-row plan without writing (purchase-time preview).
export const previewCourse = z.object({
  teacherId: ID,
  subjectId: ID,
  size: z.union([z.literal(4), z.literal(6), z.literal(10)]),
  startDate: DATE,
  startTime: TIME,
});

// TASK-095 — free-teachers-and-clashes for a single slot.
export const slotAvailabilityQuery = z.object({
  date: DATE,
  startTime: TIME,
});

// Issue a voucher (B.5): hours bucket only, no teacher/slot.
export const createVoucher = z.object({
  student: studentInput,
  totalHours: z.union([z.literal(5), z.literal(10), z.literal(15)]),
});

export const updateStatus = z.object({
  action: z.enum(["confirm", "attend", "sick-leave", "cancel"]),
  reason: z.string().optional(),
  // Admin override for the advance-notice leave rule (UC-029).
  override: z.boolean().optional(),
});

// Who can be booked against an existing entitlement (REQ-022 / TASK-051). FIRST_TRIAL / SINGLE_SESSION are
// deliberately not served here — those tabs use `GET /students?q=`.
export const eligibleStudentsQuery = z.object({
  type: z.enum(["COURSE_PACKAGE", "VOUCHER"]),
  // TASK-088 — name · nickname · parent phone, via the SAME `studentSearchConditions` as /students and
  // /bookings. Optional: omitting it must leave the response exactly as it was.
  q: z.string().trim().min(1).optional(),
});

// Staff people management (REQ-019 / TASK-048). All demographics optional — never block quick entry.
export const parentsQuery = z.object({
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const createParent = z.object({
  phone: z.string().trim().min(9),
  name: z.string().trim().max(128).nullish(),
  province: z.string().trim().max(64).nullish(),
  note: z.string().trim().max(500).nullish(), // TASK-050 — `parents.note` existed but was unreachable
});

export const updateParent = z.object({
  phone: z.string().trim().min(9).optional(),
  name: z.string().trim().max(128).nullish(),
  province: z.string().trim().max(64).nullish(),
  note: z.string().trim().max(500).nullish(),
});

export const createParentStudent = z.object({
  name: z.string().trim().min(1).max(128),
  nickname: z.string().trim().max(64).nullish(),
  note: z.string().trim().max(500).nullish(),
  // TASK-050 — optional demographics so a student can be created COMPLETE in one call (the FE no longer
  // needs create → PATCH, where a failure between the two left a student with no demographics).
  gender: z.string().trim().max(32).nullish(),
  birthDate: DATE.nullish(),
  nationality: z.string().trim().max(64).nullish(),
});

export const updateStudent = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  nickname: z.string().trim().max(64).nullish(),
  gender: z.string().trim().max(32).nullish(),
  birthDate: DATE.nullish(), // DOB — age is derived at read time, never stored
  nationality: z.string().trim().max(64).nullish(),
  note: z.string().trim().max(500).nullish(),
});

// Bulk-confirm many bookings in one call (REQ-008 / SPEC-011). 1..100 booking ids.
export const bulkConfirm = z.object({
  ids: z.array(ID).min(1).max(100),
});

// Manual move/edit a booking (reschedule). At least one field required.
export const moveBooking = z
  .object({
    teacherId: ID.optional(),
    subjectId: ID.optional(),
    date: DATE.optional(),
    startTime: TIME.optional(),
    note: z.string().optional(),
  })
  .refine((d) => Object.values(d).some((value) => value !== undefined), {
    message: "ต้องระบุอย่างน้อย 1 ฟิลด์ที่จะแก้ไข",
  });

// SPEC-028 / TASK-093 — one body for the shared plan-edit applier (discriminated on `kind`).
export const planChange = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mark-absence"),
    bookingId: ID,
    planned: z.boolean(),
    reason: z.string().trim().max(500).optional(),
    override: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("insert"),
    teacherId: ID,
    subjectId: ID,
    date: DATE,
    startTime: TIME,
  }),
  z
    .object({
      kind: z.literal("move"),
      bookingId: ID,
      teacherId: ID.optional(),
      subjectId: ID.optional(),
      date: DATE.optional(),
      startTime: TIME.optional(),
      override: z.boolean().optional(),
    })
    .refine(
      (d) =>
        d.teacherId !== undefined ||
        d.subjectId !== undefined ||
        d.date !== undefined ||
        d.startTime !== undefined,
      { message: "ต้องระบุอย่างน้อย 1 ฟิลด์ที่จะแก้ไข" },
    ),
]);

export const setAvailability = z
  .object({
    teacherId: ID.optional(),
    type: TEACHER_TYPE.optional(),
    active: z.boolean(),
  })
  .refine((d) => !!d.teacherId !== !!d.type, {
    message: "ระบุ teacherId หรือ type อย่างใดอย่างหนึ่ง (ไม่ใช่ทั้งคู่)",
  });

export const updateCourse = z.object({
  adminUnlocked: z.boolean().optional(),
});

// Staff/admin login (B.7).
export const login = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

// Teacher type ordering (B.2) — exactly the 3 types, no duplicates.
export const setTeacherTypeOrder = z.object({
  order: z
    .array(TEACHER_TYPE)
    .length(3)
    .refine((a) => new Set(a).size === 3, "ต้องระบุครบ 3 ประเภท ไม่ซ้ำ"),
});

// Teacher lifecycle (SPEC-004 / TASK-016).
export const createTeacher = z.object({
  name: z.string().trim().min(1).max(128),
  nickname: z.string().trim().min(1).max(64),
  type: TEACHER_TYPE,
  workDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  subjectIds: z.array(z.string().uuid()).optional(),
});

export const updateTeacher = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  nickname: z.string().trim().min(1).max(64).optional(),
  type: TEACHER_TYPE.optional(),
  subjectIds: z.array(z.string().uuid()).optional(),
});

// Local freelance budget admin (SPEC-005 / TASK-019).
export const setFreelanceBudget = z.object({
  monthlyBudgetMinor: z.number().int().min(0),
  rateMinor: z.number().int().min(0),
  reorderMinor: z.number().int().min(0).nullable().optional(),
});

export const topUpBudget = z.object({
  amountMinor: z.number().int().positive(),
});

export const teachersQuery = z.object({
  archived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

/** 0=Sun … 6=Sat — วันที่ครูมาสอน (ตั้งในหน้าจัดการครู) */
export const setTeacherWorkDays = z.object({
  workDays: z
    .array(z.number().int().min(0).max(6))
    .min(1, "ต้องเลือกอย่างน้อย 1 วัน")
    .max(7)
    .refine((days) => new Set(days).size === days.length, "วันซ้ำ"),
});

// TASK-100 — preview the orphan impact of a proposed workDays change (query: comma-separated weekdays, e.g. "1,2,3").
export const workDaysImpactQuery = z.object({
  workDays: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean).map(Number))
    .pipe(z.array(z.number().int().min(0).max(6)).max(7)),
});

/** Admin over-budget override for a freelance teacher (SPEC-001 / TASK-008). */
export const setLimitOverride = z.object({
  override: z.boolean(),
});

// ───────────────────────────── Badges ─────────────────────────────

const BADGE_COLOR = z.enum(BADGE_COLORS as unknown as [string, ...string[]]);

export const createBadgeType = z.object({
  name: z.string().trim().min(1),
  sortOrder: z.number().int().optional(),
});

export const updateBadgeType = z
  .object({
    name: z.string().trim().min(1).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "ต้องระบุอย่างน้อย 1 ฟิลด์ที่จะแก้ไข",
  });

export const createBadgeValue = z.object({
  badgeTypeId: ID,
  label: z.string().trim().min(1),
  color: BADGE_COLOR,
  sortOrder: z.number().int().optional(),
});

export const updateBadgeValue = z
  .object({
    label: z.string().trim().min(1).optional(),
    color: BADGE_COLOR.optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "ต้องระบุอย่างน้อย 1 ฟิลด์ที่จะแก้ไข",
  });

// List badges. includeInactive=true = admin management view (query string → boolean).
export const badgesQuery = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((val) => val === "true"),
});

// Set the badges on a booking (replaces all): ≤ 1 value per type — enforced in service.
export const setBookingBadges = z.object({
  badgeValueIds: z.array(ID),
});

// Badge dashboard aggregation over a date range.
export const badgeReportQuery = z.object({
  from: DATE,
  to: DATE,
});

// ── Teacher LINE link requests (REQ-020 Stage 2 / TASK-075) ──
export const linkRequestsQuery = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).default("PENDING"),
});

// `teacherId` is optional here and REQUIRED by the service when the request carries none (a nickname
// collision) — the rule lives in `decideApproval` so both the route and any future caller obey it.
export const approveLinkRequest = z.object({
  teacherId: ID.optional(),
  decidedBy: z.string().trim().min(1).max(120).optional(),
});

export const rejectLinkRequest = z.object({
  decidedBy: z.string().trim().min(1).max(120).optional(),
});

// ── Importing an in-progress entitlement (SPEC-025 / TASK-079) ──
// 🔴 A separate SCHEMA for a separate VERB. `expiryDate` is REQUIRED and taken as given — an imported course
// started months ago, so computing it from the start date would silently extend or shorten what the family
// bought. There is deliberately no `skipRevenue` flag anywhere: import and sale are different endpoints.
export const importCoursePackage = z.object({
  student: studentInput,
  teacherId: ID,
  subjectId: ID,
  size: z.coerce.number().int().min(1).max(100), // NOT restricted to 4/6/10 — an off-card size is
  usedSessions: z.coerce.number().int().min(0), //  importable on purpose: they already bought it
  startDate: DATE, // when the REMAINING sessions resume
  startTime: TIME,
  expiryDate: DATE,
  note: z.string().optional(),
});

// SPEC-033 / TASK-112 — add a one-time EXTRA paid session to a course (SINGLE_SESSION, soft-linked, out of quota).
export const extraSession = z.object({
  teacherId: ID,
  subjectId: ID,
  date: DATE,
  startTime: TIME,
});

// SPEC-031 / TASK-108 — record an equipment rental. `code` ∈ the four rental codes; `hours` a positive int; `refId`
// optional (present = session add-on, absent = standalone). The registry (`isRentalCode`) is the source of validity.
export const recordRental = z.object({
  code: z.string().refine(isRentalCode, "รหัสอุปกรณ์เช่าไม่ถูกต้อง"),
  hours: z.coerce.number().int().positive("จำนวนชั่วโมงต้องมากกว่า 0").max(24),
  refId: z.string().uuid().optional(),
  // TASK-108 follow-up (owner Q2=both): a STANDALONE rental has no natural key, so the client supplies one per
  // action → a double-submit posts once (AC #4). Ignored when refId is present (that's already idempotent).
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const importVoucher = z.object({
  student: studentInput,
  totalHours: z.coerce.number().int().min(1).max(100),
  usedHours: z.coerce.number().int().min(0),
  expiryDate: DATE,
});

// SPEC-029 / TASK-101 — PUT /api/settings/:key. Shape-check only; the registry's `parse` owns the real
// bounds/coercion (single source of validity), so accept a number or numeric string and let the service reject.
export const putSetting = z.object({
  value: z.union([z.number(), z.string()]),
});
