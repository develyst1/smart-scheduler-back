// DB rows → API DTOs. This is the "ready-to-use" layer: every booking ships with
// its teacher/student/subject/course already embedded so the FE never joins.

import type { ProvenanceView } from "../lib/checkin-channel";
import { toCourseSummary } from "../lib/leave";
import { voucherRemaining, voucherStatus } from "../lib/voucher";
import { fmtDate, hhmm } from "../lib/time";
import { courseRentalSummary, toRentalDTO } from "../lib/rental-row";
import { COURSE_LIVE } from "../lib/course-plan";
import { isGroupSlotClash } from "../lib/group-clash";
import { GROUP_KIND_PRICE_GROUP } from "../lib/sale-items";
import { courseKindOf, joinChildNames } from "../lib/duo-course";
import { rateFacts } from "../lib/coach-rate";

export const toTeacherBase = (t: any) => ({
  id: t.id,
  name: t.name,
  nickname: t.nickname,
  type: t.type,
});

export const toTeacherDTO = (t: any) => ({
  id: t.id,
  name: t.name,
  nickname: t.nickname,
  type: t.type,
  active: t.active,
  // Guard against a dangling teacher_subjects row (no joined subject) — else `ts.subject.id` throws
  // and crashes the whole endpoint (was the PATCH /api/teachers/availability 500). TASK-029.
  //
  // 🔴 SPEC-061 / TASK-173 (REQ-065): **inactive subjects are dropped here, and only here.** Every program
  // picker in the app (single · course · voucher · trial · plan) renders `teacher.subjectOptions`, which is
  // this field — so `active = false` means "not something to choose", at the cause, for every screen present
  // and future. It is deliberately NOT applied on any read path: a booking made on `1st Trial` last month must
  // still render with that name (AC-3), which is why the row is deactivated and never deleted.
  subjects: (t.teacherSubjects ?? [])
    .filter((ts: any) => ts.subject && ts.subject.active !== false)
    .map((ts: any) => ({
      id: ts.subject.id,
      name: ts.subject.name,
      kind: ts.subject.kind ?? "PRIVATE", // TASK-437 — the picker filters by TYPE (DUO ⇔ the DUO create), never by name
    })),
  lineLinked: !!t.lineUserId,
  archived: t.archived ?? false,
  // SPEC-004 money-setup gate: set by attachSetupIncomplete (true = no budget/salary yet → not bookable).
  setupIncomplete: false,
  workDays: (t.workDays ?? [0, 1, 2, 3, 4, 5, 6]).map(Number),
  // Populated from the teacher's backoffice EXPENSE item by attachTeacherQuotas (SPEC-001).
  // All money fields are satang. remainingMinor = current stock; budgetMinor = configured
  // monthly budget; reorderMinor = near-cap warning threshold; overLimit = remainingMinor ≤ 0.
  hourlyRate: null as number | null,
  budgetMinor: null as number | null,
  remainingMinor: null as number | null,
  reorderMinor: null as number | null,
  overLimit: false,
  // Durable admin over-budget override (app_settings). Set by attachLimitOverrides / setLimitOverride.
  limitOverride: false,
});

import { levelName, perksForLevel } from "../lib/crm";

const studentRef = (s: any) => {
  const level = s.crmLevel ?? 1;
  const { priorityBooking, perks } = perksForLevel(level);
  return {
    id: s.id,
    name: s.name,
    nickname: s.nickname ?? null,
    crmPoints: s.crmPoints ?? 0,
    crmLevel: level,
    crmLevelName: levelName(level),
    // UC-020 — สิทธิประโยชน์ตามระดับ (priorityBooking = advisory ให้ staff)
    priorityBooking,
    perks,
  };
};

// Badge value as embedded on a booking (already joined with its type + value).
export const toBookingBadge = (bb: any) => ({
  typeId: bb.badgeTypeId,
  typeName: bb.type?.name ?? null,
  valueId: bb.badgeValueId,
  label: bb.value?.label ?? null,
  color: bb.value?.color ?? null,
});

export const toBadgeValueDTO = (v: any) => ({
  id: v.id,
  typeId: v.badgeTypeId,
  label: v.label,
  color: v.color,
  active: v.active,
  sortOrder: v.sortOrder,
});

export const toBadgeTypeDTO = (t: any) => ({
  id: t.id,
  name: t.name,
  active: t.active,
  sortOrder: t.sortOrder,
  values: (t.values ?? [])
    .slice()
    .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
    .map(toBadgeValueDTO),
});

/**
 * SPEC-070 / TASK-224 (REQ-078 AC-18) — **the one accessor for a booking's teachers.**
 *
 * `bookings.teacher_id` is the first teacher; `booking_teachers` holds the additional ones. 🔴 Nothing outside
 * this function may read either source: two call sites reading two sources is how the two get to disagree, and
 * a booking that shows two teachers on the calendar and one in a report is worse than either answer alone.
 *
 * `teachers[0]` is ALWAYS the row's `teacher_id`, so the order is stable and the existing single-teacher
 * meaning survives everywhere. The four lesson types can never have extras (validation refuses the field, and
 * nothing else writes the table), so this returns exactly one for them — by construction, not by filtering.
 */
export const bookingTeachers = (b: any) => [
  toTeacherBase(b.teacher),
  // `additionalTeachers` is absent when a caller did not load the relation — which is correct for the lesson
  // types and, for `OTHER`, is why the relation lives in the shared `withBookingRelations` rather than being
  // opted into per query.
  ...(b.additionalTeachers ?? [])
    .filter((a: any) => a?.teacher)
    .map((a: any) => toTeacherBase(a.teacher)),
];

const groupFacts = (b: any): { key: string | null; kind: string | null; priceGroup: string | null; name: string | null; seatCap: number | null; yieldedAt: string | null; closedAt: string | null; clash: boolean; seats: Array<{ bookingId: string; studentId: string | null; studentName: string | null; status: string; courseId: string | null }>; teacherRates: Record<string, number>; ratePostedAt: string | null } | null => {
  if (b.bookingType !== "GROUP") return null;
  const o = otherFacts({ ...b, bookingType: "OTHER" })!;
  return {
    key: b.groupKey ?? null,
    kind: o.kind,
    // TASK-399 — the resolver's own mapping, so the FE never maps kind → price group itself.
    priceGroup: o.kind === "DUO" || o.kind === "GROUP" ? GROUP_KIND_PRICE_GROUP[o.kind] : null,
    name: b.otherTitle ?? null,
    // TASK-453 — `null` cap = UNCAPPED (the service skips the check); the FE prints the seats with no denominator.
    seatCap: b.headCount ?? null,
    // 🔴 TASK-453 (REQ-105 §3/§8) — the yield, the close, and the CLASH — the last DERIVED by the ONE function
    // (`lib/group-clash.ts`), never a stored flag and never a second spelling of the rule.
    yieldedAt: b.slotYieldedAt ? new Date(b.slotYieldedAt).toISOString() : null,
    closedAt: b.groupClosedAt ? new Date(b.groupClosedAt).toISOString() : null,
    clash: isGroupSlotClash({ slotYieldedAt: b.slotYieldedAt ?? null, liveSeats: (b.seats ?? []).filter((x: any) => COURSE_LIVE.has(x.status)).length }),
    seats: (b.seats ?? []).map((s: any) => ({ bookingId: s.id, studentId: s.studentId ?? null, studentName: s.student?.nickname ?? s.student?.name ?? null, status: s.status, courseId: s.courseId ?? null })),
    teacherRates: o.teacherRates,
    ratePostedAt: o.ratePostedAt,
  };
};

const otherFacts = (b: any): { kind: string | null; headCount: number | null; teacherRates: Record<string, number>; ratePostedAt: string | null } | null => {
  if (b.bookingType !== "OTHER") return null;
  const teacherRates: Record<string, number> = {};
  const primaryId = b.teacherId ?? b.teacher?.id; // a hand-built row may carry only the relation
  if (b.teacherRateMinor != null && primaryId) teacherRates[primaryId] = b.teacherRateMinor;
  for (const a of b.additionalTeachers ?? []) if (a?.rateMinor != null && a.teacherId) teacherRates[a.teacherId] = a.rateMinor;
  return { kind: b.otherKind ?? null, headCount: b.headCount ?? null, teacherRates, ratePostedAt: b.ratePostedAt ? new Date(b.ratePostedAt).toISOString() : null };
};

/**
 * 🔴 TASK-224 / AC-10 — the ONE field every surface renders a booking by; TASK-423 made it the ONE function (it used to be
 * four hand-copied chains — the DTO, the reminder, the two slot-clash sentences). An อื่นๆ row reads as its typed title;
 * a DUO course row (TASK-420) as BOTH children `A & B`; every other row as the student's nickname, then name. Never
 * blank for a lesson row (validation guarantees an อื่นๆ row with no student carries a title).
 */
export const displayNameOf = (b: any): string => b.otherTitle ?? studentNamesOf(b) ?? "";

/**
 * 🔴 TASK-499 — THE public check-in answer's `booking`, by ALLOW-LIST. The doors that take no login (the token page, the
 * shop-front single and batch) answered with the whole admin DTO: the COACH'S PAY (`rate` — the key-59 mask is registered
 * AFTER these routes and never ran on them), an ADMIN'S USERNAME (`discount.actor`), staff's `note`, the course's internals and
 * the child's CRM fields — none of it read by any page. The pages read exactly these six, so the family loses nothing.
 * 🔑 An allow-list, not a deny-list: the admin DTO has 33 keys and grows every round, so a deny-list makes every FUTURE field
 * public by default. Here a new field is private until someone decides a family should see it — by adding it HERE.
 * (DUO: the first child's name, exactly as before — unchanged inside a leak fix; named for @Fern.)
 */
export const toPublicCheckinBooking = (b: any) =>
  b
    ? {
        date: b.date,
        startTime: b.startTime,
        endTime: b.endTime,
        student: b.student ? { name: b.student.name } : null,
        subject: b.subject ? { name: b.subject.name } : null,
        teacher: b.teacher ? { nickname: b.teacher.nickname } : null,
      }
    : null;

/**
 * TASK-425 — the STUDENT part of that rule (no title): a DUO row's `A & B`, else the nickname, then the name; `null` for
 * a studentless row. The notice worker and the payload writers print it on the `Student :` line (an อื่นๆ row's title
 * already rides in `program`, so it must not repeat here); every other surface prints `displayNameOf`.
 */
export const studentNamesOf = (b: any): string | null =>
  (b.coStudent ? joinChildNames(b.student, b.coStudent) : null) ?? b.student?.nickname ?? b.student?.name ?? null;

/**
 * 🔴 TASK-481 — WHERE the check-in came from (`bookings.checkin_source`), RAW and untranslated: `shopfront-qr` · `checkin-qr` ·
 * `line` · `end-of-day` · a staff USERNAME · `null`. It is `null` unless the caller asks for it (`provenance: true`), and
 * a caller asks only for an UNSCOPED (admin) read — Sober's ruling B: a scoped teacher never sees which admin marked their
 * class, and neither does a parent on the public scan. Opt-in on purpose: a new read defaults to hiding it.
 */
/**
 * 🔴 TASK-488 — the THREE-STATE read (was TASK-481's boolean): `raw` — an unscoped admin read: the channel, the actor, and the
 * legacy `checkinSource` (kept for the FE until the drop), as stored · `masked` — a scoped teacher: all three `null` · omitted
 * — EVERY other read, incl. the PUBLIC scan: the keys are ABSENT. A parent never sees an actor — not masked, not coarsened, absent.
 */
const bookingProvenance = (b: any, view: ProvenanceView | undefined) =>
  !view
    ? {}
    : view === "masked"
      ? { checkinSource: null, checkinChannel: null, checkinActor: null }
      : { checkinSource: (b.checkinSource as string | null | undefined) ?? null, checkinChannel: (b.checkinChannel as string | null | undefined) ?? null, checkinActor: (b.checkinActor as string | null | undefined) ?? null };
export const toBookingDTO = (b: any, opts: { courseLast?: boolean; campKidCount?: number | null; provenance?: ProvenanceView } = {}) => ({
  id: b.id,
  ...bookingProvenance(b, opts.provenance),
  date: b.date,
  startTime: hhmm(b.startTime),
  endTime: hhmm(b.endTime),
  bookingType: b.bookingType,
  status: b.status,
  note: b.note ?? null,
  // TASK-368 (REQ-089 §5) — the closed cancel code (`note` above holds the human sentence). Rides for every
  // reader, `null` on a live row: the calendar shows cancelled sessions on request and must say why.
  cancelReason: b.cancelReason ?? null,
  // SPEC-063 / TASK-178 (REQ-068) — what a parent told us about this session ("พาน้องมาด้วย 2 คน"), distinct
  // from `note` above, which is what the system did to it (cancel reason, auto-extend, leave).
  attendeeNote: b.attendeeNote ?? null,
  // TASK-224 (REQ-078): `null` for an อื่นๆ booking with no student / no program. 🚫 Never a placeholder —
  // REQ-065 exists because `1st Trial` sitting in `subjects` leaked into the program picker and had to be
  // filtered back out. A booking with no program has none, and says so.
  student: b.student ? studentRef(b.student) : null,
  coStudent: b.coStudent ? studentRef(b.coStudent) : null, // TASK-420 — a DUO course row's second child
  teacher: toTeacherBase(b.teacher),
  subject: b.subject ? { id: b.subject.id, name: b.subject.name } : null,
  // TASK-224 — the typed name of an อื่นๆ booking; `null` on the four lesson types.
  title: b.otherTitle ?? null,
  // 🔴 TASK-224 / AC-10 — the ONE field every surface renders a booking by. Computed for **every** booking
  // type (a 1HR's is its student's nickname, unchanged), so "never blank, never the word อื่นๆ" is a property
  // of this function instead of a fallback re-invented at 31 FE call sites, each free to get it wrong
  // differently. Validation guarantees the inputs: an อื่นๆ booking with no student must carry a title.
  displayName: displayNameOf(b),
  // 🔴 TASK-224 / AC-18 — EVERY assigned teacher, from the ONE accessor. Present on every booking type
  // (length 1 for the four lesson types), so the FE has one shape rather than two.
  teachers: bookingTeachers(b),
  // TASK-394 (REQ-095 Stage 1) — the ECA/Free/KOL facts of an OTHER, `null` for a lesson type. The rates keyed by
  // teacher (the primary from `bookings`, each extra from its `booking_teachers` row) so the FE's per-teacher inputs
  // read ONE object; `ratePostedAt` is reserved and null this stage.
  other: otherFacts(b),
  // TASK-423 (REQ-095 §13.3) — a COURSE_PACKAGE row's coach rate: the session's override, the course's default and the
  // effective one, from the ONE rule in `lib/coach-rate.ts`; `null` on every other type.
  rate: rateFacts(b, b.course ?? null),
  // TASK-397 (REQ-095 Stage 2a) — a GROUP row: its seats; a seat: its group. `null` / absent otherwise.
  group: groupFacts(b),
  groupId: b.groupId ?? null,
  groupName: b.group?.otherTitle ?? null,
  // TASK-418 (REQ-095 §11) — a DERIVED camp hour: its day object and week (the FE merges contiguous cells; the swap door).
  campWeekDayId: b.campWeekDayId ?? null,
  // TASK-454 (REQ-105 §5) — the kid count for THAT CAMP DATE, passed in by the calendar (the same number the day
  // banner shows). ⚠️ It is a DAY fact, so every camp block of that date prints the SAME number — the count is of
  // children enrolled on the day, not of children with this coach (kids are not tied to coaches).
  campKidCount: opts.campKidCount ?? null,
  otherSeriesKey: b.otherSeriesKey ?? null, // TASK-428 — the Manage-plan link from an OTHER row
  campWeekId: b.campWeekDay?.campWeekId ?? null,
  course: b.course ? toCourseSummary(b.course) : null,
  badges: (b.badges ?? []).map(toBookingBadge),
  // TASK-371 (REQ-091 Deploy A) — the session's rental ROW: `{ code, remark, paid } | null`. It REPLACES
  // `hasRental` (SPEC-045 / TASK-190), which was a ledger-derived presence marker with zero FE readers. The
  // row is a relation in every reader's `withBookingRelations` (one batched query), so nothing is passed in;
  // a reader that did not load the relation gets `null`, which is honest for the row it did not ask for.
  rental: toRentalDTO(b.rental),
  // TASK-366 (REQ-089 item 5) — is this row its course's LAST session? The `Last` badge on the admin schedule.
  // Same shape as TASK-190's marker was: passed in, because the calendar answers it for the whole range in ONE grouped
  // read (`liveEndDateByCourse` over `deriveLiveEndDate` — the plan's own end, no second rule). Computed on the
  // calendar and the single-booking read; `false` on the paginated list and the create/pause/resume returns,
  // where no screen draws the badge.
  courseLast: opts.courseLast ?? false,
  // SPEC-059 / TASK-171 (REQ-063 req 8 / AC-10) — the discount captured at booking, so the record can answer
  // what/why/who. `null` — not a partly-filled object — when there is no discount: an absent discount and a
  // discount of nothing must not look alike on screen.
  //
  // `value` travels as the HUMAN number it was typed as (percent, or whole baht per TASK-168); the FE formats
  // it. Converting to satang here would put a second unit conversion on the wire, which is the exact shape of
  // the bug this feature has already produced once.
  //
  // ⚠️ `actor` is carried for the record, but per SA it is NOT for the card today: one shared login makes it
  // the same name for everyone, and a meaningless "who" on screen is worse than none. It becomes displayable
  // when per-person logins exist; until then "who" stays answerable from the stored column.
  discount: b.discountKind
    ? {
        kind: b.discountKind,
        value: b.discountValue,
        reason: b.discountReason ?? null,
        actor: b.discountActor ?? null,
      }
    : null,
  // Conflict resolution (B.1) — null/false for ordinary bookings.
  pendingSlot: b.pendingSlot ?? false,
  incomingBookingId: b.incomingBookingId ?? null,
  rescheduleTo: b.rescheduleTo
    ? {
        reason: b.rescheduleTo.reason,
        date: b.rescheduleTo.date,
        teacherId: b.rescheduleTo.teacherId,
        startTime: hhmm(b.rescheduleTo.startTime),
        endTime: hhmm(b.rescheduleTo.endTime),
      }
    : null,
});

/** TASK-420 / TASK-422 — the course DTO's three DUO facts: the second child, the per-class rate (stored, never posted)
 *  and the DERIVED kind. ONE builder for every course reader that carries them (the list/view/create/PATCH DTO and the
 *  entitlement plan) — never a second hand-built object. */
export const duoCourseFacts = (c: any) => ({
  coStudent: c.coStudent ? studentRef(c.coStudent) : null,
  classRateMinor: c.classRateMinor ?? null,
  courseKind: courseKindOf(c),
});

export const toCourseWithStudent = (c: any) => ({
  ...toCourseSummary(c),
  student: studentRef(c.student),
  ...duoCourseFacts(c), // TASK-420
  // TASK-140: the course's OWN program (`course_packages.subject_id`) is the source of truth now. The old
  // derivation from `bookings[0].subject` stays as a fallback for rows created before 0018's back-fill ran
  // (and for callers that load bookings but not the subject relation). null when neither is loaded.
  subject: c.subject
    ? { id: c.subject.id, name: c.subject.name }
    : c.bookings?.[0]?.subject
      ? { id: c.bookings[0].subject.id, name: c.bookings[0].subject.name }
      : null,
  // TASK-373 (REQ-091 Deploy B) — the course's whole-course rental, DERIVED from the rows: from a grouped read the
  // list spreads on (`courseRental`), else from the loaded rows (the create's return). `null` = not rented.
  // 🔻 TASK-390 (REQ-091 §14): `null` ALSO once `rental_removed_at` is set — the marker wins over any past paid rows
  // still on the course (they are history, not a rental the family still has). `paidUpfront` is the stored variant
  // (`0038`; a pre-0038 rented course reads `true` — it was, by construction); `unpaidSessions` what is left to collect.
  rental: courseRentalDTO(c),
});

const courseRentalDTO = (c: any): { code: string; remark: string | null; paidUpfront: boolean; unpaidSessions: number } | null => {
  if (c.rentalRemovedAt) return null;
  const s = c.courseRental ?? courseRentalSummary(c.bookings ?? []);
  return s ? { code: s.code, remark: s.remark, paidUpfront: c.rentalPaidUpfront ?? true, unpaidSessions: s.unpaidSessions } : null;
};

export const toVoucherDTO = (v: any) => ({
  id: v.id,
  totalHours: v.totalHours,
  usedHours: v.usedHours,
  remaining: voucherRemaining(v),
  expiryDate: v.expiryDate,
  student: studentRef(v.student),
  // TASK-439 (REQ-103): the ONE derived status (ENDED > EXPIRED > EXHAUSTED > ACTIVE) + the end stamp; `remaining` stays
  // readable on an ended voucher — the balance is frozen, not hidden ("ENDED · Nh left").
  status: voucherStatus(v, fmtDate(new Date())),
  endedAt: v.endedAt ?? null,
  endReason: v.endReason ?? null,
});
