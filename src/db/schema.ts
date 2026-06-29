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

export const students = pgTable(
  "students",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    nickname: text("nickname"),
    phone: text("phone"),
    // Option C backoffice targets, nullable now so finance never migrates a hot table later.
    lineUserId: text("line_user_id"),
    parentLineUserId: text("parent_line_user_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("students_name_idx").on(t.name)],
);

export const teachers = pgTable("teachers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  nickname: text("nickname").notNull(),
  type: teacherType("type").notNull(),
  active: boolean("active").notNull().default(true),
  // Phase-1 notify target. No id → cannot push; surfaced as `lineLinked` in the API.
  lineUserId: text("line_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // No two live bookings in the same teacher slot — DB-level human-error guard.
    // PENDING_RESCHEDULE is excluded: a booking being moved out releases its slot so
    // the incoming (pendingSlot) booking can hold it during conflict resolution (B.1).
    uniqueIndex("bookings_teacher_slot_uq")
      .on(t.teacherId, t.date, t.startTime)
      .where(sql`${t.status} not in ('CANCELLED', 'PENDING_RESCHEDULE')`),
    index("bookings_date_idx").on(t.date),
    index("bookings_teacher_date_idx").on(t.teacherId, t.date),
    index("bookings_student_idx").on(t.studentId),
    index("bookings_course_idx").on(t.courseId),
  ],
);

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

// ───────────────────────────── Relations ─────────────────────────────
// Enable `db.query.bookings.findMany({ with: { teacher, student, subject, course } })`
// so aggregate endpoints compose ready-to-use payloads in one round-trip.

export const studentsRelations = relations(students, ({ many }) => ({
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

export const bookingsRelations = relations(bookings, ({ one }) => ({
  student: one(students, { fields: [bookings.studentId], references: [students.id] }),
  teacher: one(teachers, { fields: [bookings.teacherId], references: [teachers.id] }),
  subject: one(subjects, { fields: [bookings.subjectId], references: [subjects.id] }),
  course: one(coursePackages, {
    fields: [bookings.courseId],
    references: [coursePackages.id],
  }),
  voucher: one(vouchers, { fields: [bookings.voucherId], references: [vouchers.id] }),
}));
