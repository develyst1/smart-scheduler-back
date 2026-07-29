import { z } from "zod";
import { BADGE_COLORS } from "./lib/badge-colors";

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
  });

// รายการวอยเชอร์ (GET /api/vouchers) — กรองตามนักเรียน/ค้นหาชื่อได้
export const vouchersQuery = z.object({
  studentId: ID.optional(),
  q: z.string().trim().min(1).optional(),
});

// Register a recurring course package (B.4): size + first slot → weekly sessions.
export const createCoursePackage = z.object({
  student: studentInput,
  teacherId: ID,
  subjectId: ID,
  size: z.union([z.literal(4), z.literal(6), z.literal(10)]),
  startDate: DATE,
  startTime: TIME,
  note: z.string().optional(),
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
