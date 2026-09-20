import { z } from "zod";
import { GROUP_KINDS, HUMAN_OTHER_KINDS } from "./lib/other-kind";
import { CAMP_DAY_STATUSES, CAMP_HALVES, CAMP_KINDS, CAMP_PLANS, CAMP_WEEK_STATUSES, MAX_DAILY_DAYS } from "./lib/camp";
import { bookingStatus } from "./db/schema";
import { BADGE_COLORS } from "./lib/badge-colors";
import { isRentalCode } from "./lib/sale-items";
import { END_REASONS, plannedRowExists } from "./lib/course-plan";

// TASK-160: declared early so the sale schemas below can reference it.
export const discountInput = z.object({
  kind: z.enum(["PERCENT", "BAHT"]),
  /** A HUMAN number — PERCENT: 0–100. BAHT: **whole baht** (TASK-168: this said "minor units", which was the
   *  100×-wrong contract). The real bounds are re-checked against the price by `planDiscount` — zod must not
   *  hold a second, drifting copy of a money rule. */
  value: z.number(),
  reason: z.string().trim().min(1, "ต้องระบุเหตุผลของส่วนลด"),
});


/**
 * SPEC-063 / TASK-178 (REQ-068) — the attendee note. ~200 chars: long enough for "พาน้องมาด้วย 2 คน แพ้ถั่ว",
 * short enough that nobody files a medical history in a field that is shown on a calendar cell and pushed to a
 * teacher's phone. The not-for-PII wording on the form is Porter's; this is the structural half of the same rule.
 */
export const attendeeNote = z.string().trim().max(200, "โน้ตต้องไม่เกิน 200 ตัวอักษร");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ต้องเป็นรูปแบบ YYYY-MM-DD");
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "ต้องเป็นรูปแบบ HH:mm");
const ID = z.string().uuid();

const BOOKING_TYPE = z.enum([
  "FIRST_TRIAL",
  "SINGLE_SESSION",
  "COURSE_PACKAGE",
  "VOUCHER",
  // SPEC-070 / TASK-224 (REQ-078) — a booking that is not a lesson.
  "OTHER",
]);

/**
 * The four LESSON types. TASK-224 relaxed `student` / `subjectId` to optional **in the schema** so `OTHER` can
 * omit them — this set is what keeps them mandatory **in practice** for everything that was already shipping.
 *
 * 🔴 AC-14: the four existing types must behave byte-identically. Optional-in-the-object plus a refine that
 * refuses the absence is the same contract as `.notNull()`, with one type carved out — and a test per type
 * pins it, because "we relaxed a field for one case" is exactly how the other four quietly lose a guard.
 */
const LESSON_TYPES = ["FIRST_TRIAL", "SINGLE_SESSION", "COURSE_PACKAGE", "VOUCHER"] as const;
const isLessonType = (t: string) => (LESSON_TYPES as readonly string[]).includes(t);
/**
 * 🔴 TASK-270 (DEF-1) — DERIVED from the database enum, never listed here again.
 *
 * It was a hand-written 7. The DB enum had 9. `PAUSED` reached the database, the service filter and the
 * tray, and stopped at THIS line: `GET /bookings?status=PAUSED` was a 400, so the tray rendered
 * *ไม่มีรายการที่พักไว้* while a paused booking existed — **as shipped, pause read as DELETE.**
 * ⚠️ And `NO_SHOW` had the identical gap and nobody ever found it: historical rows render but cannot be
 * listed. **The defect was not a forgotten line; it was that forgetting was possible.**
 *
 * ✅ Safe because this enum has exactly ONE use — `bookingsQuery.status`, a READ filter. The write path
 * takes VERBS (`confirm | attend | sick-leave | cancel`), so widening what may be queried opens no write
 * hole and nobody can PATCH a booking straight to `PAUSED` past `pauseBooking`'s guards.
 * 🚫 Do NOT reuse this for a write, and do NOT merge it with `SLOT_INACTIVE_STATUSES` /
 * `CALENDAR_HIDDEN_STATUSES`: those answer QUESTIONS and have reasons to differ. This is *every status*.
 */
const BOOKING_STATUS = z.enum(bookingStatus.enumValues);
const TEACHER_TYPE = z.enum(["FULL_TIME", "PART_TIME", "FREELANCE"]);

export const calendarQuery = z.object({
  date: DATE,
  view: z.enum(["day", "week"]).default("day"),
  // TASK-368 (REQ-089 §5) — show the range's CANCELLED sessions too (display only). The `archived` pattern, NOT
  // `z.coerce.boolean()`: coercion makes the string "false" true. "true" is on; "false", absent are off; anything
  // else is a 400.
  includeCancelled: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export const reportQuery = z.object({ date: DATE });

// Booking dropdown: search students by name / nickname / parent phone.
export const studentsQuery = z.object({
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // TASK-392 (REQ-093) — `archived=true` ⇒ ONLY the archived students (the restore view); default hides them.
  archived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  // TASK-058 retired the `bookable` opt-in — suspended households are now excluded by default for every
  // consumer. Zod strips unknown keys, so an older client still sending `bookable=true` is simply ignored
  // (it asked for the behaviour that is now the default), which is what makes the FE/BE deploy order free.
  // TASK-414 (REQ-099) — the birthday filter: a MONTH range (both or neither; wraps past December) or `noDob`.
  birthMonthFrom: z.coerce.number().int().min(1).max(12).optional(),
  birthMonthTo: z.coerce.number().int().min(1).max(12).optional(),
  // TASK-416 — optional YEARS beside the months: both or neither, each only with its month, from <= to (no wrap on a dated range).
  birthYearFrom: z.coerce.number().int().min(1900).max(2100).optional(),
  birthYearTo: z.coerce.number().int().min(1900).max(2100).optional(),
  noDob: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
})
  .refine((d) => (d.birthMonthFrom === undefined) === (d.birthMonthTo === undefined), { message: "ต้องระบุเดือนเกิดทั้งช่วง (birthMonthFrom และ birthMonthTo)", path: ["birthMonthTo"] })
  .refine((d) => (d.birthYearFrom === undefined) === (d.birthYearTo === undefined), { message: "ต้องระบุปีเกิดทั้งช่วง (birthYearFrom และ birthYearTo)", path: ["birthYearTo"] })
  .refine((d) => d.birthYearFrom === undefined || d.birthMonthFrom !== undefined, { message: "ปีเกิดต้องใช้คู่กับเดือนเกิด", path: ["birthYearFrom"] })
  .refine((d) => d.birthYearFrom === undefined || d.birthMonthFrom === undefined || d.birthYearFrom * 100 + d.birthMonthFrom <= d.birthYearTo! * 100 + d.birthMonthTo!, { message: "ช่วงวันเกิดต้องเริ่มก่อนหรือเท่ากับจุดสิ้นสุด", path: ["birthYearTo"] })
  .refine((d) => !(d.noDob && d.birthMonthFrom !== undefined), { message: "noDob ใช้ร่วมกับช่วงเดือน/ปีเกิดไม่ได้", path: ["noDob"] }); // years imply months (the rule above), so this one clause covers all four

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
    // TASK-224: optional in the OBJECT so `OTHER` may omit them; the four lesson types still refuse the
    // absence in the refinements below (`isLessonType`). Relaxing the shape must not relax the contract.
    student: studentInput.optional(),
    teacherId: ID,
    subjectId: ID.optional(),
    date: DATE,
    startTime: TIME,
    bookingType: BOOKING_TYPE,
    courseId: ID.optional(),
    voucherId: ID.optional(),
    note: z.string().optional(),
    // TASK-178 (REQ-068) — the attendee note, separate from `note` (which the status flows own).
    attendeeNote: attendeeNote.optional(),
    // Optional badge value ids to tag the new booking (≤ 1 per badge type; enforced in service).
    badgeValueIds: z.array(ID).optional(),
    // TASK-162 (REQ-063) — a discount on a TRIAL / SINGLE session: captured here (an admin is present at
    // booking), posted by the day-end job (nobody is present then). Refused on any other booking type.
    discount: discountInput.optional(),
    // ── SPEC-070 / TASK-224 (REQ-078) — `OTHER` only; refused outright on the four lesson types below ──
    /** The typed name of an อื่นๆ booking ("ประชุมทีม", "ปิดปรับปรุงลาน"). Required when there is no student. */
    otherTitle: z.string().trim().min(1).optional(),
    /** A typed charge in satang. EITHER this OR `otherPriceItemId` — never both (AC-12). */
    otherPriceMinor: z.number().int().min(1).optional(),
    /** A `bo.item` id to charge instead of a typed amount. */
    otherPriceItemId: ID.optional(),
    /** AC-18/19/20 — the teachers BEYOND `teacherId`. `OTHER` only; `teacherId` is always the first. */
    additionalTeacherIds: z.array(ID).optional(),
    /** TASK-399 (REQ-095 Stage 2b) — the WALK-IN seat: the GROUP row this single session sits in. `SINGLE_SESSION` only. */
    groupId: ID.optional(),
    // ── TASK-394 (REQ-095 Stage 1) — ECA · Free/KOL. `OTHER` only; refused on the four lesson types below. ──
    /** ECA | FREE | KOL — the code list in `lib/other-kind.ts`; an unknown kind ⇒ 400. */
    otherKind: z.enum(HUMAN_OTHER_KINDS).optional(),
    /** How many heads the slot serves (≥ 0). */
    headCount: z.number().int().min(0).optional(),
    /** ONE map keyed by teacher id (the primary AND the extras), satang ≥ 0; an id not on the booking ⇒ 400 (service). */
    teacherRates: z.record(ID, z.number().int().min(0)).optional(),
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
  })
  // ── TASK-224 — AC-14: the four LESSON types keep every guard they had ──
  //
  // 🔴 These two exist because the columns stopped enforcing it (`0029` dropped both NOT NULLs so `OTHER` can
  // omit them). Without them, relaxing the schema for one type would silently let a 1HR be booked with no
  // student and a course session with no program — the change nobody asked for, arriving for free.
  .refine((d) => !isLessonType(d.bookingType) || !!d.student, {
    message: "การจองประเภทนี้ต้องระบุนักเรียน",
    path: ["student"],
  })
  .refine((d) => !isLessonType(d.bookingType) || !!d.subjectId, {
    message: "การจองประเภทนี้ต้องเลือกโปรแกรม",
    path: ["subjectId"],
  })
  // ── TASK-224 — `OTHER`'s own rules ──
  //
  // AC-10: an อื่นๆ booking with no student MUST carry a title, because the title is the only thing left to
  // name it with. `displayName` then never falls through to "" — that is the property, and it is enforced
  // here rather than papered over with a placeholder at render time.
  .refine((d) => d.bookingType !== "OTHER" || !!d.student || !!d.otherTitle, {
    message: "กรุณาระบุชื่อรายการ",
    path: ["otherTitle"],
  })
  // AC-12: EITHER a typed amount OR a catalogue item. 🔴 Refuse — never clamp, never pick one for the user
  // (REQ-063's line). `booking_other_price_chk` is the same rule in the database.
  .refine((d) => d.otherPriceMinor === undefined || d.otherPriceItemId === undefined, {
    message: "เลือกได้อย่างเดียว: ระบุจำนวนเงินเอง หรือเลือกรายการจากแคตตาล็อก",
    path: ["otherPriceMinor"],
  })
  // At least one teacher is ALWAYS required (AC-19) — `teacherId` is `ID`, so that is already true. What this
  // adds is that the EXTRA ones are a closed, sane list: no duplicates, and never a repeat of the first.
  .refine((d) => !d.additionalTeacherIds || new Set(d.additionalTeacherIds).size === d.additionalTeacherIds.length, {
    message: "ครูซ้ำกัน",
    path: ["additionalTeacherIds"],
  })
  .refine((d) => !d.additionalTeacherIds || !d.additionalTeacherIds.includes(d.teacherId), {
    message: "ครูซ้ำกับครูคนแรก",
    path: ["additionalTeacherIds"],
  })
  // TASK-399 — `groupId` is the walk-in seat's field: SINGLE_SESSION only (a course seat comes through the course create).
  .refine((d) => d.groupId === undefined || d.bookingType === "SINGLE_SESSION", {
    message: "ที่นั่งในกลุ่มใช้ได้เฉพาะคาบเดี่ยว (SINGLE_SESSION)",
    path: ["groupId"],
  })
  // ── TASK-224 — the four LESSON types must REFUSE every `OTHER` field ──
  //
  // 🔴 Refused outright, not ignored. A silently-dropped field is how `other_title` ends up on a course
  // session that nothing renders it for, and how AC-20 ("the other four take exactly one teacher") stops
  // being true of the DATA while still being true of the screen.
  .refine(
    (d) =>
      d.bookingType === "OTHER" ||
      (d.otherTitle === undefined &&
        d.otherPriceMinor === undefined &&
        d.otherPriceItemId === undefined &&
        d.additionalTeacherIds === undefined &&
        // TASK-394 — the three ECA/Free/KOL fields join the refusal: dropped silently is how a lesson grows a head count
        d.otherKind === undefined &&
        d.headCount === undefined &&
        d.teacherRates === undefined),
    {
      message: "ฟิลด์นี้ใช้ได้เฉพาะการจองประเภท “อื่นๆ”",
      path: ["bookingType"],
    },
  );

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
  /** SPEC-064 / TASK-188 (REQ-036 B3) — filter by lifecycle status, server-side so the counts and paging are
   *  true. Omitted = every status. */
  status: z.enum(["CANCELLED", "DROPPED", "COMPLETED", "EXPIRED", "ACTIVE"]).optional(),
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Register a recurring course package (B.4): size + first slot → weekly sessions.
// TASK-371 (REQ-091 Deploy A) — a rental ROW on a session. The remark rule lives in `lib/rental-row.ts`
// (`rentalRemarkRequired`) so the service and this schema cannot disagree; here only the shape.
export const recordBookingRental = z.object({
  code: z.string().refine(isRentalCode, "รหัสอุปกรณ์เช่าไม่ถูกต้อง"),
  remark: z.string().trim().max(200).optional(),
});

export const createCoursePackage = z
  .object({
    student: studentInput,
    teacherId: ID,
    subjectId: ID,
    size: z.union([z.literal(4), z.literal(6), z.literal(10)]),
    startDate: DATE,
    startTime: TIME,
    note: z.string().optional(),
    // TASK-178 (REQ-068) — one attendee note, applied to every session the course creates.
    attendeeNote: attendeeNote.optional(),
    // SPEC-049 / TASK-148 — weeks the family already knows they'll miss, declared at creation (1-based).
    // Each becomes a free `SICK_LEAVE` (no quota) and the engine appends its make-up.
    absentWeeks: z.array(z.number().int().min(1)).optional(),
    // TASK-160 (REQ-063) — optional discount at the point of sale (admin-only route).
    discount: discountInput.optional(),
    // TASK-373 (REQ-091 Deploy B) — whole-course rental: one tier for every session. The same shape as the session
    // rental; the remark RULE (set + ride) is the service's, as in TASK-371.
    // 🔻 TASK-390 (REQ-091 §14) — `paidUpfront` (default TRUE = today: every row born paid, one post). FALSE = pay per
    // session: rows born unpaid, NO post at creation, each session's paid press posts one.
    rental: recordBookingRental.extend({ paidUpfront: z.boolean().default(true) }).optional(),
    // TASK-397 (REQ-095 Stage 2a) — sell this course INTO a group: every planned session becomes a SEAT on the group
    // row of its date; the teacher / weekday / start must be the group's (the FE prefills them; a mismatch ⇒ 400).
    groupKey: ID.optional(),
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
  })
  // 🔻 TASK-361 (`REQ-089 item 1`) — THE LOCK IS GONE. This read `w <= d.size`: a declared absence could name only
  // one of the `size` chain weeks, so an `Extended` (make-up) row could never be declared absent. The customer:
  // *"คลาสที่เป็น extended ไม่ต้องล็อกค่ะ สามารถลาได้เหมือนกัน"*. ⇒ a position may name ANY row the plan draws,
  // make-ups included — and the rule for which rows exist is `plannedRowExists`, the SAME function the preview
  // and the create use. A position beyond the drawn plan is still refused: it names a row nobody will see.
  .refine((d) => !d.absentWeeks || d.absentWeeks.every((w) => plannedRowExists(w, d.size, new Set(d.absentWeeks))), {
    message: "สัปดาห์ที่ลาต้องอยู่ในช่วงของคอร์ส",
  });
  // 🔻 TASK-363 (`REQ-089 §4.2`) — THE CAP IS GONE. A `< size` refine stood here since TASK-148 (*"the whole
  // course can't be absent — that isn't a course"*), and TASK-361 kept it while removing the lock. The OWNER then
  // ruled FULL UNLOCK: *every planned row leaveable, no ceiling, advance leave still free* — the case being a
  // family that must leave an EXTENDED session too, where on a size-4 the cap refused the very first make-up
  // leave. ⇒ a course may be born with EVERY original absent; the engine appends a make-up for each, and
  // `plannedRowCount` still terminates (rows ≤ size + |absent|) — both pinned with values.
  // 🚫 No request bound was added in its place: "no ceiling" is the ruling, and a bound is a DECISION (on the
  // owner's list with a number). The only refusal left is the existence rule above: a position beyond the
  // drawn plan names a row nobody will see.

// TASK-095 — generate the editable `size`-row plan without writing (purchase-time preview).
export const previewCourse = z.object({
  teacherId: ID,
  subjectId: ID,
  size: z.union([z.literal(4), z.literal(6), z.literal(10)]),
  startDate: DATE,
  startTime: TIME,
  // TASK-148 — preview the plan WITH the declared absences, so what is shown is what gets saved (AC-2).
  absentWeeks: z.array(z.number().int().min(1)).optional(),
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
  // TASK-160 (REQ-063) — optional discount at the point of sale (admin-only route).
  discount: discountInput.optional(),
});

export const updateStatus = z.object({
  action: z.enum(["confirm", "attend", "sick-leave", "cancel"]),
  reason: z.string().optional(),
  /** SPEC-067 / TASK-211 (REQ-074) — the closed-set cancel reason, beside `reason`'s free text. Optional here
   *  and REQUIRED by the service for 1HR / voucher cancels: the rule lives in one place, and zod holding a
   *  second copy of a domain rule is how the two drift. */
  reasonCode: z.enum(END_REASONS).optional(), // TASK-406: the ONE set (`lib/course-plan.ts`), no second copy here
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
  // TASK-411 (REQ-098) — `archived=true` ⇒ ONLY the archived parents (the restore view); default hides them.
  archived: z.enum(["true", "false", "1", "0"]).optional().transform((v) => v === "true" || v === "1"),
});
export const parentDetailQuery = z.object({ archived: z.enum(["true", "false", "1", "0"]).optional().transform((v) => v === "true" || v === "1") });

export const createParent = z.object({
  phone: z.string().trim().min(9),
  name: z.string().trim().max(128).nullish(),
  province: z.string().trim().max(64).nullish(),
  // 🔻 TASK-354 (`REQ-088 §10`) — 2000, not 500: `REQ-088 §9` made the MACHINE append addresses to this note, and
  // a cap the machine can exceed means the ADMIN cannot save what the SYSTEM wrote. 2000 ≈ 25 lines — room for
  // ten appended addresses plus a staff note, still a guard against a runaway append. The number is @Sober's.
  note: z.string().trim().max(2000).nullish(), // TASK-050 — `parents.note` existed but was unreachable
});

export const updateParent = z.object({
  phone: z.string().trim().min(9).optional(),
  name: z.string().trim().max(128).nullish(),
  province: z.string().trim().max(64).nullish(),
  note: z.string().trim().max(2000).nullish(), // 🔻 TASK-354 — the parent's note, same cap as on create
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
// TASK-394 (REQ-095 Stage 1) — edit an OTHER's kind / head count / rates. Its OWN route, not `moveBooking`: that one
// re-times a session and TELLS the teacher; this must notify nobody (the note's precedent, TASK-178).
export const editOtherBooking = z
  .object({
    otherKind: z.enum(HUMAN_OTHER_KINDS).optional(),
    headCount: z.number().int().min(0).optional(),
    teacherRates: z.record(ID, z.number().int().min(0)).optional(),
  })
  .refine((d) => Object.values(d).some((value) => value !== undefined), { message: "ต้องระบุอย่างน้อย 1 ฟิลด์ที่จะแก้ไข" });

// TASK-397 (REQ-095 Stage 2a) — a DUO/Group SERIES: the OTHER series body + a name, a kind and a seat cap. DUO ⇒ exactly 2.
export const groupSeries = z
  .object({
    name: z.string().trim().min(1),
    groupKind: z.enum(GROUP_KINDS),
    seatCap: z.number().int().min(2).max(12),
    teacherId: ID,
    additionalTeacherIds: z.array(ID).optional(),
    teacherRates: z.record(ID, z.number().int().min(0)).optional(),
    startTime: TIME,
    dates: z.array(DATE).min(1).max(60),
  })
  .refine((d) => d.groupKind !== "DUO" || d.seatCap === 2, { message: "DUO มี 2 ที่นั่งเสมอ", path: ["seatCap"] })
  .refine((d) => new Set(d.dates).size === d.dates.length, { message: "วันที่ซ้ำกัน", path: ["dates"] })
  .refine((d) => !d.additionalTeacherIds || new Set(d.additionalTeacherIds).size === d.additionalTeacherIds.length, { message: "ครูซ้ำกัน", path: ["additionalTeacherIds"] })
  .refine((d) => !d.additionalTeacherIds || !d.additionalTeacherIds.includes(d.teacherId), { message: "ครูซ้ำกับครูคนแรก", path: ["additionalTeacherIds"] });

// TASK-397 — swap the group's teacher from this date on (or this date only); every seat moves with it.
export const groupTeacherSwap = z.object({ teacherId: ID, fromHereOn: z.boolean() });

// TASK-394 — the SERIES: one OTHER row per date, all or nothing. `endTime` is derived (+1h) as for every booking.
export const otherSeries = z
  .object({
    title: z.string().trim().min(1),
    otherKind: z.enum(HUMAN_OTHER_KINDS),
    headCount: z.number().int().min(0),
    note: z.string().optional(),
    teacherId: ID,
    additionalTeacherIds: z.array(ID).optional(),
    teacherRates: z.record(ID, z.number().int().min(0)).optional(),
    startTime: TIME,
    dates: z.array(DATE).min(1).max(60),
  })
  .refine((d) => new Set(d.dates).size === d.dates.length, { message: "วันที่ซ้ำกัน", path: ["dates"] })
  .refine((d) => !d.additionalTeacherIds || new Set(d.additionalTeacherIds).size === d.additionalTeacherIds.length, { message: "ครูซ้ำกัน", path: ["additionalTeacherIds"] })
  .refine((d) => !d.additionalTeacherIds || !d.additionalTeacherIds.includes(d.teacherId), { message: "ครูซ้ำกับครูคนแรก", path: ["additionalTeacherIds"] });

// ── TASK-401 (REQ-095 Stage 3a) — Balance camp. Shapes only; the rules (units, credit, capacity, transitions) are the service's. ──
export const campWeeksQuery = z.object({ from: DATE, to: DATE });
const HHMM = z.string().regex(/^\d{2}:\d{2}$/, "ต้องเป็นรูปแบบ HH:MM");
export const createCampWeek = z
  .object({ name: z.string().trim().min(1).max(80), startDate: DATE, endDate: DATE, capacity: z.number().int().min(1).nullable().optional(), teacherIds: z.array(ID).optional(), windowStart: HHMM.optional(), windowEnd: HHMM.optional() }) // TASK-418: the week's window (default 10:00–15:00)
  .refine((d) => d.endDate >= d.startDate, { message: "วันสิ้นสุดต้องไม่ก่อนวันเริ่ม", path: ["endDate"] });
export const updateCampWeek = z
  .object({ name: z.string().trim().min(1).max(80).optional(), capacity: z.number().int().min(1).nullable().optional(), teacherIds: z.array(ID).optional(), status: z.enum(CAMP_WEEK_STATUSES).optional(), windowStart: HHMM.optional(), windowEnd: HHMM.optional() })
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: "ต้องระบุอย่างน้อย 1 ฟิลด์ที่จะแก้ไข" });
// TASK-418 — the per-day swap: who holds the block that day, and when (the rules — whole hours, the bounds — are the service's).
export const updateCampWeekDay = z
  .object({ teacherIds: z.array(ID).optional(), startTime: HHMM.optional(), endTime: HHMM.optional() })
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: "ต้องระบุอย่างน้อย 1 ฟิลด์ที่จะแก้ไข" });
export const redeemCampDays = z
  .object({ weekId: ID, dates: z.array(DATE).min(1).max(7), half: z.enum(CAMP_HALVES) })
  .refine((d) => new Set(d.dates).size === d.dates.length, { message: "วันที่ซ้ำกัน", path: ["dates"] });
export const createCampPackage = z
  .object({
    studentId: ID,
    kind: z.enum(CAMP_KINDS),
    plan: z.enum(CAMP_PLANS),
    days: z.number().int().min(1).max(MAX_DAILY_DAYS).optional(),
    discount: discountInput.optional(),
    note: z.string().trim().max(200).optional(),
    firstWeek: redeemCampDays.optional(),
  })
  .refine((d) => (d.plan === "DAILY") === (d.days !== undefined), { message: "แพ็กเกจรายวันต้องระบุ days; แพ็กเกจรายสัปดาห์ต้องไม่ระบุ", path: ["days"] });
export const campPackagesQuery = z.object({ studentId: ID });
// TASK-403: `PLANNED` is the UNDO (3b) and needs a reason (3..200 — the check-in-correction precedent); a mark never carries one.
export const markCampDay = z
  .object({ status: z.enum(CAMP_DAY_STATUSES), reason: z.string().trim().min(3).max(200).optional() })
  .refine((d) => (d.status === "PLANNED") === (d.reason !== undefined), { message: "การยกเลิกการบันทึกต้องระบุเหตุผล (3–200 ตัวอักษร) — การบันทึกปกติไม่ต้องระบุ", path: ["reason"] });
export const campCheckinBody = z.object({ token: z.string().trim().min(8) });

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

// TASK-377 (REQ-092 Stage 1) — user management. Shape only; the username pattern, the password minimum and the
// last-super-admin rule are the service's (one source, one sentence each).
export const createUser = z.object({
  username: z.string().trim().min(1),
  password: z.string(),
  displayName: z.string().trim().min(1),
  isSuperAdmin: z.boolean().optional(),
  teacherId: ID.nullable().optional(), // TASK-406 — the link; null/absent = an admin
});
export const updateUser = z.object({
  displayName: z.string().trim().optional(),
  isSuperAdmin: z.boolean().optional(),
  teacherId: ID.nullable().optional(), // TASK-406 — set, change or clear (null) the link
});
// TASK-406 (REQ-097 C-2) — a LINKED teacher's own leave: the date, optionally the subset (else every live session that day), the reason.
export const teacherLeave = z.object({
  date: DATE,
  sessionIds: z.array(ID).min(1).max(50).optional(),
  reason: z.string().trim().min(3).max(200),
});
export const resetPassword = z.object({ password: z.string() });
// TASK-381 (Stage 2) — shape only; the key registry and the password rule are the service's.
export const setUserMenus = z.object({ keys: z.array(z.string()) });
export const setUserActions = z.object({ keys: z.array(z.string()) }); // TASK-385 — same shape, the action registry is the service's
// TASK-387 (Stage 4) — shape only; the name rule, the key registry and the refusals are the service's.
export const createRole = z.object({ name: z.string(), description: z.string().nullable().optional(), keys: z.array(z.string()) });
export const updateRole = z.object({ name: z.string().optional(), description: z.string().nullable().optional(), keys: z.array(z.string()).optional() });
export const setUserRole = z.object({ roleId: z.string().nullable() });
export const changeOwnPassword = z.object({ currentPassword: z.string(), newPassword: z.string() });

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
  // Shape only: any plausible size. The RULE — 4/6/10, or any size WITH an explicit `leaveQuota` — lives in
  // the service (`decideImportSize`, TASK-213), because a domain rule copied into zod is a rule that drifts.
  size: z.coerce.number().int().min(1).max(100),
  /**
   * 🔴 TASK-215 — the field that makes an off-card import possible, and the one that was MISSING here.
   *
   * TASK-213 added it to the *preview* schema and not to this one, so zod stripped it from every save: the
   * form asked for the quota, the admin filled it in, and the server refused the import as if they had left it
   * blank. Nothing errored — a field that is not in the schema simply ceases to exist, which is the quietest
   * possible failure and the reason the DoD for this fix is a ROUND TRIP, not a schema unit test.
   */
  leaveQuota: z.coerce.number().int().min(0).max(20).optional(),
  usedSessions: z.coerce.number().int().min(0), // importable on purpose: they already bought it
  startDate: DATE, // when the REMAINING sessions resume
  startTime: TIME,
  /** TASK-213 — OPTIONAL: omitted ⇒ the server computes it from `size (+ leaveQuota)`. A date the admin
   *  actually typed is still honoured (the ruling that kept 164 imported expiries out of the FIX-007 repair). */
  expiryDate: DATE.optional(),
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
  // TASK-160: optional discount; validated against the LINE TOTAL (hours × rate) in the service.
  code: z.string().refine(isRentalCode, "รหัสอุปกรณ์เช่าไม่ถูกต้อง"),
  hours: z.coerce.number().int().positive("จำนวนชั่วโมงต้องมากกว่า 0").max(24),
  refId: z.string().uuid().optional(),
  // TASK-108 follow-up (owner Q2=both): a STANDALONE rental has no natural key, so the client supplies one per
  // action → a double-submit posts once (AC #4). Ignored when refId is present (that's already idempotent).
  idempotencyKey: z.string().min(1).max(200).optional(),
  // TASK-160 (REQ-063) — validated against the LINE TOTAL (hours × rate) in the service, never the unit rate.
  discount: discountInput.optional(),
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

/**
 * SPEC-063 / TASK-178 (REQ-068) — the per-session note edit. Its own body, and its own route, deliberately:
 * `moveBooking` re-times a session and tells the teacher about it, and a note is **not a status change** (AC-8).
 * Routing it through the move path would have made "fix a typo in a note" push a LINE message to a teacher.
 * `null` clears the note; that is a real edit, not a missing field.
 */
export const setAttendeeNote = z.object({ attendeeNote: attendeeNote.nullable() });

/** SPEC-064 / TASK-181 (REQ-036) — ending a course early. The reason is re-checked in the service against the
 *  enum: zod is the shape, the service is the rule, and a course ended with an unqueryable reason is an ended
 *  course nobody can find again. `note` is optional free text. */
export const endCourse = z.object({
  reason: z.string().trim().min(1, "ต้องระบุเหตุผลในการยกเลิกคอร์ส"),
  note: z.string().trim().max(500).optional(),
});
export const endCoursePreview = z.object({
  reason: z.string().trim().optional(),
  note: z.string().trim().max(500).optional(),
});

// SPEC-065 / TASK-198 — pause / resume a course.
export const dropCourse = z.object({
  /** Free text, optional: a pause has no closed set of causes the way an early ending does. */
  reason: z.string().trim().max(500).optional(),
});
/**
 * SPEC-075 / TASK-260 (REQ-076 AC-13) — put ONE booking back on the calendar, at any date and time.
 *
 * 🚫 There is deliberately no `pauseBooking` schema: **the pause route takes no body at all** (§8's ratified
 * contract). With no field to put one in, **AC-8's reason cannot be sent even by accident** — the absence is
 * structural rather than a promise.
 */
export const resumeBooking = z.object({
  date: DATE,
  startTime: TIME,
  // 🔻 TASK-359 (`REQ-089 item 8`) — the admin PICKS the teacher on resume. OPTIONAL: absent ⇒ the booking's own
  // teacher, byte for byte as before; present ⇒ that teacher on the resumed row and in the clash message.
  teacherId: ID.optional(),
});
/**
 * 🔴 TASK-282 §7 — **the course-CREATION question, and it is REQUIRED.** A resume is a RE-PLAN
 * (owner ruling): the admin says when the remaining sessions start and at what time, exactly as they do when
 * the course is sold.
 *
 * 🔑 **Required is the point, not a tightening.** TASK-264 made the old `expiryDate` optional, which left
 * `{}` and `{ expiryDate }` as **two paths through one function, and only one of them was ever trialled** —
 * that non-determinism is DEF-2 itself. A re-plan always carries a schedule, so there is **one path**.
 * ⚠️ **Breaking for anyone sending `{}`.** The FE is the only caller and changes in the same shipment
 * (TASK-287).
 *
 * 🚫 **No `expiryDate`, and its absence is structural.** It is now DERIVED to cover the last planned
 * session (TASK-282 §7.1(2) — DEF-4), so there is no expiry request left to be wrong. The EDIT verb
 * (`updateCourseExpiry`) keeps its own required field; that one has nothing to infer from.
 *
 * 🚫 **And no `weekday`** — `weekdayOf(startDate)` is what course creation derives
 * (`createCoursePackage` has no such field either). Two fields cannot contradict each other; three can.
 */
export const resumeCourse = z.object({
  startDate: DATE,
  startTime: TIME,
  // 🔻 TASK-359 (`REQ-089 item 8`) — the admin PICKS the teacher on resume. OPTIONAL: absent ⇒ the course's
  // first session's teacher, byte for byte as before; present ⇒ that teacher on every re-planned session.
  teacherId: ID.optional(),
});

/**
 * TASK-264 (REQ-082 AC-1) — move a course's expiry. One field, deliberately: this verb changes one date and
 * nothing else (AC-3), and a schema that accepted more would be the first place that stopped being true.
 * 🚫 No `reason` — see the table's comment; nobody asked for one and an audit prompt goes unfilled.
 */
export const updateCourseExpiry = z.object({
  expiryDate: DATE,
});

/** SPEC-068 / TASK-213 — the import form's live preview (expiry default + quota + max week). Read-only. */
export const importCoursePreview = z.object({
  size: z.coerce.number().int().min(1).max(100),
  leaveQuota: z.coerce.number().int().min(0).max(20).optional(),
  usedSessions: z.coerce.number().int().min(0),
  startDate: DATE,
});
