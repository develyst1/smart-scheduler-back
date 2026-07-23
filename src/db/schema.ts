// ─────────────────────────────────────────────────────────────────────────────
// Drizzle schema — Scheduling API (frontoffice). Owned & migrated by THIS repo.
// Shared PostgreSQL database `smart_scheduler`. Finance/inventory tables (Option C backoffice)
// live in `smart-scheduler-backoffice-back`.
// Design notes:
//  - IDs are uuid (opaque, mergeable, no sequence contention in a shared DB).
//  - Students & subjects are NORMALIZED (1 row each) — bookings reference them by
//    id. Aggregate responses re-embed names so the frontend never joins.
//  - Enum string values match the frontend unions exactly (no mapping layer).
// ─────────────────────────────────────────────────────────────────────────────

import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  pgSchema,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  smallint,
  date,
  time,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";

// ───────────────────────────── Enums ─────────────────────────────

export const teacherType = pgEnum("teacher_type", [
  "FULL_TIME",
  "PART_TIME",
  "FREELANCE",
]);

export const bookingType = pgEnum("booking_type", [
  "FIRST_TRIAL",
  "SINGLE_SESSION",
  "COURSE_PACKAGE",
  "VOUCHER",
]);

export const bookingStatus = pgEnum("booking_status", [
  "PENDING",
  "CONFIRMED",
  "ATTENDED",
  "SICK_LEAVE",
  "NO_SHOW", // auto-cut end-of-day (UC-012): confirmed class, no check-in, no leave → quota cut
  "EXTENDED",
  "PENDING_RESCHEDULE", // conflict resolution (B.1): awaiting parent acceptance of a move
  "CANCELLED",
]);

export const notifyStatus = pgEnum("notify_status", [
  "PENDING",
  "SENT",
  "FAILED",
  "SKIPPED",
]);

// ───────────────────────────── Core people ─────────────────────────────

// A parent/guardian, keyed by phone. One parent (one phone, one LINE account) owns
// up to MAX_STUDENTS_PER_PARENT students (their children). The phone is the unique
// identity used to link a LINE account and to look the parent up from the booking
// dropdown. The 5-per-parent cap is enforced in the service, not the DB.
export const parents = pgTable(
  "parents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull(),
    name: text("name"), // ชื่อผู้ปกครอง (ถ้ามี) — optional
    // LINE OA userId once the parent links via the chat flow (C.4). Null = not linked.
    lineUserId: text("line_user_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("parents_phone_uq").on(t.phone),
    uniqueIndex("parents_line_user_id_uq")
      .on(t.lineUserId)
      .where(sql`${t.lineUserId} is not null`),
  ],
);

export const students = pgTable(
  "students",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    nickname: text("nickname"),
    // The guardian who owns this student. Nullable for walk-in/trial students
    // created before a parent is known; the LINE flow always sets it.
    parentId: uuid("parent_id").references(() => parents.id, { onDelete: "restrict" }),
    // Option C backoffice target, nullable now so finance never migrates a hot table later.
    lineUserId: text("line_user_id"),
    /** CRM (C.2): แต้มสะสม + ระดับลูกค้า — คำนวณ level จาก points ใน service */
    crmPoints: integer("crm_points").notNull().default(0),
    crmLevel: smallint("crm_level").notNull().default(1),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("students_name_idx").on(t.name),
    index("students_parent_idx").on(t.parentId),
  ],
);

export const teachers = pgTable("teachers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  nickname: text("nickname").notNull(),
  type: teacherType("type").notNull(),
  active: boolean("active").notNull().default(true),
  /** Offboarded (soft-delete). Distinct from `active` (pause): archived hides the teacher from the
   *  roster + calendar and stops ops money going forward (SPEC-004). Hard-delete is blocked by the
   *  bookings FK, so archive is the only removal. */
  archived: boolean("archived").notNull().default(false),
  /** 0=Sun … 6=Sat — ครูมาสอนได้วันไหนบ้าง (ปฏิทินซ่อนคอลัมน์นอกวันนี้) */
  workDays: smallint("work_days").array().notNull().default(sql`ARRAY[0,1,2,3,4,5,6]::smallint[]`),
  // Phase-1 notify target. No id → cannot push; surfaced as `lineLinked` in the API.
  lineUserId: text("line_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// REQ-006 (TASK-024): the freelance ceiling now lives as a `bo.item` (unit=hour) in the SHARED DB.
// `bo` migrations are owned by backoffice-back; scheduling only reads/writes item + movement here
// (direct same-DB access → the freelance decrement stays atomic inside the booking tx, no HTTP).
export const bo = pgSchema("bo");
export const boDirection = bo.enum("direction", ["INCOME", "EXPENSE"]);
export const boCadence = bo.enum("cadence", [
  "VARIABLE",
  "FIXED_MONTHLY",
  "FIXED_DAILY",
  "FIXED_QUARTERLY",
]);

export const boItem = bo.table("item", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  unit: text("unit").notNull().default("each"),
  direction: boDirection("direction").notNull(),
  cadence: boCadence("cadence").notNull().default("VARIABLE"),
  ceilingQty: integer("ceiling_qty"),
  remainingQty: integer("remaining_qty"),
  unitPriceMinor: integer("unit_price_minor").notNull().default(0),
  ownerRef: text("owner_ref"),
  externalSource: text("external_source"),
  active: boolean("active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const boMovement = bo.table("movement", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id")
    .notNull()
    .references(() => boItem.id, { onDelete: "cascade" }),
  qty: integer("qty").notNull(),
  remainingAfter: integer("remaining_after"),
  valueMinor: integer("value_minor").notNull().default(0),
  reason: text("reason"),
  refType: text("ref_type"),
  refId: text("ref_id"),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// DORMANT after TASK-024 — superseded by the `bo.item` ceiling. Data migrates in TASK-025; drop later.
export const freelanceBudgets = pgTable("freelance_budgets", {
  teacherId: uuid("teacher_id")
    .primaryKey()
    .references(() => teachers.id, { onDelete: "cascade" }),
  monthlyBudgetMinor: integer("monthly_budget_minor").notNull(), // configured monthly budget (satang)
  rateMinor: integer("rate_minor").notNull(), // per-job drawdown = rate × 1h (bookings are 1h)
  remainingMinor: integer("remaining_minor").notNull(), // current remaining; may go < 0 under override
  reorderMinor: integer("reorder_minor"), // near-cap warning threshold (satang)
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const subjects = pgTable("subjects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
});

// Which subjects a teacher can teach (M2M).
export const teacherSubjects = pgTable(
  "teacher_subjects",
  {
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.teacherId, t.subjectId] })],
);

// ───────────────────────── Entitlements ─────────────────────────

// Fixed-schedule course (4/6/10 sessions) with a leave quota. Derived fields
// (leaveQuota/leaveRemaining/maxWeek/leaveLocked) are COMPUTED in the service,
// never stored — single source of truth = the rule, not a cached column.
export const coursePackages = pgTable(
  "course_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    size: smallint("size").notNull(), // 4 | 6 | 10
    usedSessions: integer("used_sessions").notNull().default(0),
    leaveUsed: integer("leave_used").notNull().default(0),
    adminUnlocked: boolean("admin_unlocked").notNull().default(false),
    startDate: date("start_date").notNull(),
    weekday: smallint("weekday").notNull(), // 0-6 (Sun-Sat)
    startTime: time("start_time").notNull(),
    expiryDate: date("expiry_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("course_size_chk", sql`${t.size} in (4, 6, 10)`),
    index("course_student_idx").on(t.studentId),
  ],
);

// Voucher = hour bucket (5/10/15h), no fixed slot, no chosen teacher, ~2x expiry.
export const vouchers = pgTable("vouchers", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentId: uuid("student_id")
    .notNull()
    .references(() => students.id, { onDelete: "restrict" }),
  totalHours: smallint("total_hours").notNull(), // 5 | 10 | 15
  usedHours: integer("used_hours").notNull().default(0),
  expiryDate: date("expiry_date").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ───────────────────────────── Bookings ─────────────────────────────

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "restrict" }),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "restrict" }),
    date: date("date").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    bookingType: bookingType("booking_type").notNull(),
    status: bookingStatus("status").notNull().default("PENDING"),
    // Entitlement links — at most one is set, per booking_type.
    courseId: uuid("course_id").references(() => coursePackages.id, {
      onDelete: "set null",
    }),
    voucherId: uuid("voucher_id").references(() => vouchers.id, {
      onDelete: "set null",
    }),
    // For EXTENDED slots: which original sick-leave booking spawned this.
    extendedFromId: uuid("extended_from_id"),
    // Conflict resolution (B.1). When this booking is overbooked, it goes
    // PENDING_RESCHEDULE: `incomingBookingId` = the new booking now holding this
    // slot (created with `pendingSlot=true`), `rescheduleTo` = where this booking
    // is proposed to move (parent confirms/cancels via LINE).
    incomingBookingId: uuid("incoming_booking_id"),
    pendingSlot: boolean("pending_slot").notNull().default(false),
    rescheduleTo: jsonb("reschedule_to").$type<{
      reason: "MOVE_DAY" | "MOVE_WEEK" | "MOVE_TEACHER";
      date: string;
      teacherId: string;
      startTime: string;
      endTime: string;
    }>(),
    note: text("note"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }), // idempotent confirm/notify
    /** C.1: one-time token for QR / link check-in; issued on confirm */
    checkinToken: text("checkin_token"),
    checkinTokenExpiresAt: timestamp("checkin_token_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // No two live bookings in the same teacher slot — DB-level human-error guard.
    // SICK_LEAVE is excluded (UC-004): a student on leave is not attending and is
    // auto-extended, so staff may overbook a replacement into that freed slot.
    // (PENDING_RESCHEDULE stays excluded for any legacy rows from the old B.1 flow.)
    uniqueIndex("bookings_teacher_slot_uq")
      .on(t.teacherId, t.date, t.startTime)
      .where(sql`${t.status} not in ('CANCELLED', 'PENDING_RESCHEDULE', 'SICK_LEAVE')`),
    index("bookings_date_idx").on(t.date),
    index("bookings_teacher_date_idx").on(t.teacherId, t.date),
    index("bookings_student_idx").on(t.studentId),
    index("bookings_course_idx").on(t.courseId),
    uniqueIndex("bookings_checkin_token_uq")
      .on(t.checkinToken)
      .where(sql`${t.checkinToken} is not null`),
  ],
);

// ───────────────────── LINE OA link sessions (C.4) ─────────────────────
// Short-lived conversation state while a LINE user picks a role + enters a code.
export const lineLinkSessions = pgTable("line_link_sessions", {
  lineUserId: text("line_user_id").primaryKey(),
  step: text("step").notNull(), // CHOOSE_ROLE | AWAIT_CODE | AWAIT_STUDENT_NAME
  pendingRole: text("pending_role"), // customer | teacher | admin
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// ─────────────────────── Notification outbox (LINE) ───────────────────────
// Reliable push: write a row, a worker delivers + retries. Audit trail included.
export const notificationOutbox = pgTable("notification_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  channel: text("channel").notNull().default("line"),
  recipientType: text("recipient_type").notNull(), // 'teacher' | 'parent' | 'student'
  recipientLineUserId: text("recipient_line_user_id"),
  bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
  payload: jsonb("payload").notNull(),
  status: notifyStatus("status").notNull().default("PENDING"),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

// ─────────────────────────── App settings (KV) ───────────────────────────
// Small global settings persisted server-side (single source of truth across
// browsers/devices). First user: `teacher_type_order` (B.2) — replaces the FE
// localStorage. value is jsonb so future settings (CRM levels, etc.) can reuse it.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// ───────────────────────── Job runs (UC-012 auto-cut) ─────────────────────────
// Audit log for the end-of-day sweep, so ops can confirm the Windows Task Scheduler
// trigger actually fired and see what it cut. One row per run (idempotent re-runs
// just append another row with cut=0).
export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    job: text("job").notNull(), // "end-of-day"
    runDate: date("run_date").notNull(), // business date processed (Asia/Bangkok)
    status: text("status").notNull().default("success"), // success | failed
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("job_runs_job_date_idx").on(t.job, t.runDate)],
);

// ───────────────────────────── Badges ─────────────────────────────
// Admin-defined tags on bookings. A badge TYPE (group, e.g. "สาขา") holds many
// VALUES (e.g. "สาขา A" in blue). A booking carries at most ONE value per type.
// Replaces the idea of separate branches — a branch is just a badge type.

export const badgeTypes = pgTable("badge_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const badgeValues = pgTable(
  "badge_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    badgeTypeId: uuid("badge_type_id")
      .notNull()
      .references(() => badgeTypes.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    color: text("color").notNull(), // one of the curated palette keys (lib/badge-colors)
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("badge_values_type_idx").on(t.badgeTypeId)],
);

// A booking ↔ badge value link. `badge_type_id` is denormalized so the DB can
// enforce "one value per type per booking" (UNIQUE below).
export const bookingBadges = pgTable(
  "booking_badges",
  {
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    badgeValueId: uuid("badge_value_id")
      .notNull()
      .references(() => badgeValues.id, { onDelete: "restrict" }),
    badgeTypeId: uuid("badge_type_id")
      .notNull()
      .references(() => badgeTypes.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.bookingId, t.badgeValueId] }),
    uniqueIndex("booking_badges_one_per_type_uq").on(t.bookingId, t.badgeTypeId),
    index("booking_badges_value_idx").on(t.badgeValueId),
  ],
);

// ───────────────────────────── Relations ─────────────────────────────
// Enable `db.query.bookings.findMany({ with: { teacher, student, subject, course } })`
// so aggregate endpoints compose ready-to-use payloads in one round-trip.

export const parentsRelations = relations(parents, ({ many }) => ({
  students: many(students),
}));

export const studentsRelations = relations(students, ({ one, many }) => ({
  parent: one(parents, { fields: [students.parentId], references: [parents.id] }),
  bookings: many(bookings),
  coursePackages: many(coursePackages),
  vouchers: many(vouchers),
}));

export const teachersRelations = relations(teachers, ({ many }) => ({
  bookings: many(bookings),
  teacherSubjects: many(teacherSubjects),
}));

export const subjectsRelations = relations(subjects, ({ many }) => ({
  teacherSubjects: many(teacherSubjects),
}));

export const teacherSubjectsRelations = relations(teacherSubjects, ({ one }) => ({
  teacher: one(teachers, {
    fields: [teacherSubjects.teacherId],
    references: [teachers.id],
  }),
  subject: one(subjects, {
    fields: [teacherSubjects.subjectId],
    references: [subjects.id],
  }),
}));

export const coursePackagesRelations = relations(coursePackages, ({ one, many }) => ({
  student: one(students, {
    fields: [coursePackages.studentId],
    references: [students.id],
  }),
  bookings: many(bookings),
}));

export const vouchersRelations = relations(vouchers, ({ one }) => ({
  student: one(students, { fields: [vouchers.studentId], references: [students.id] }),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  student: one(students, { fields: [bookings.studentId], references: [students.id] }),
  teacher: one(teachers, { fields: [bookings.teacherId], references: [teachers.id] }),
  subject: one(subjects, { fields: [bookings.subjectId], references: [subjects.id] }),
  course: one(coursePackages, {
    fields: [bookings.courseId],
    references: [coursePackages.id],
  }),
  voucher: one(vouchers, { fields: [bookings.voucherId], references: [vouchers.id] }),
  badges: many(bookingBadges),
}));

export const badgeTypesRelations = relations(badgeTypes, ({ many }) => ({
  values: many(badgeValues),
}));

export const badgeValuesRelations = relations(badgeValues, ({ one, many }) => ({
  type: one(badgeTypes, { fields: [badgeValues.badgeTypeId], references: [badgeTypes.id] }),
  bookingBadges: many(bookingBadges),
}));

export const bookingBadgesRelations = relations(bookingBadges, ({ one }) => ({
  booking: one(bookings, { fields: [bookingBadges.bookingId], references: [bookings.id] }),
  value: one(badgeValues, {
    fields: [bookingBadges.badgeValueId],
    references: [badgeValues.id],
  }),
  type: one(badgeTypes, { fields: [bookingBadges.badgeTypeId], references: [badgeTypes.id] }),
}));
