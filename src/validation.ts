import { z } from "zod";

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
const RESCHEDULE_REASON = z.enum(["MOVE_DAY", "MOVE_WEEK", "MOVE_TEACHER"]);

export const calendarQuery = z.object({
  date: DATE,
  view: z.enum(["day", "week"]).default("day"),
});

export const reportQuery = z.object({ date: DATE });

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

export const createBooking = z.object({
  // scalable student reference: existing id OR an inline new student
  student: z.union([
    z.object({ id: ID }),
    z.object({
      name: z.string().trim().min(1),
      nickname: z.string().trim().optional(),
      phone: z.string().trim().optional(),
      parentLineUserId: z.string().trim().optional(),
    }),
  ]),
  teacherId: ID,
  subjectId: ID,
  date: DATE,
  startTime: TIME,
  bookingType: BOOKING_TYPE,
  courseId: ID.optional(),
  voucherId: ID.optional(),
  note: z.string().optional(),
});

// Overbook a slot: same body as createBooking + how to move the existing occupant.
export const createBookingWithReschedule = createBooking.extend({
  resolution: z.object({
    reason: RESCHEDULE_REASON,
    date: DATE,
    teacherId: ID,
    startTime: TIME,
  }),
});

export const updateStatus = z.object({
  action: z.enum(["confirm", "attend", "sick-leave", "cancel"]),
  reason: z.string().optional(),
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

// Teacher type ordering (B.2) — exactly the 3 types, no duplicates.
export const setTeacherTypeOrder = z.object({
  order: z
    .array(TEACHER_TYPE)
    .length(3)
    .refine((a) => new Set(a).size === 3, "ต้องระบุครบ 3 ประเภท ไม่ซ้ำ"),
});
