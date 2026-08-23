import { describe, expect, test } from "bun:test";
import { toBookingDTO, toCourseWithStudent, toTeacherDTO } from "./mappers";

describe("toTeacherDTO budget fields (TASK-008)", () => {
  test("carries satang budget fields, defaulting until quotas/override are attached", () => {
    const dto = toTeacherDTO({
      id: "t1",
      name: "Alice",
      nickname: "อลิซ",
      type: "FREELANCE",
      active: true,
      workDays: [1, 2, 3],
    });
    expect(dto).toMatchObject({
      id: "t1",
      type: "FREELANCE",
      hourlyRate: null,
      budgetMinor: null,
      remainingMinor: null,
      reorderMinor: null,
      overLimit: false,
      limitOverride: false,
    });
    // old hours-based field is gone (renamed to remainingMinor, satang)
    expect("quotaRemaining" in dto).toBe(false);
  });
});

describe("toCourseWithStudent — sport program (subject) derived from bookings (TASK-034)", () => {
  const base = {
    id: "c1",
    size: 10,
    usedSessions: 2,
    leaveUsed: 0,
    adminUnlocked: false,
    expiryDate: "2026-09-01",
    student: { id: "s1", name: "น้องโอ๊ด", nickname: "โอ๊ด" },
  };

  test("derives subject from the course's first booking", () => {
    const dto = toCourseWithStudent({
      ...base,
      bookings: [{ subject: { id: "sub1", name: "Balance Bike" } }],
    });
    expect(dto.subject).toEqual({ id: "sub1", name: "Balance Bike" });
  });

  test("subject is null when bookings aren't loaded / empty (safe for other callers)", () => {
    expect(toCourseWithStudent(base).subject).toBeNull();
    expect(toCourseWithStudent({ ...base, bookings: [] }).subject).toBeNull();
  });

  // TASK-140 — the course's own column is the source of truth; the booking derivation is now only a fallback
  // for rows that predate 0018's back-fill.
  test("the course's own subject wins over the first booking's", () => {
    const dto = toCourseWithStudent({
      ...base,
      subject: { id: "sub-course", name: "Surfskate" },
      bookings: [{ subject: { id: "sub1", name: "Balance Bike" } }],
    });
    expect(dto.subject).toEqual({ id: "sub-course", name: "Surfskate" });
  });

  test("a course with no subject_id yet still derives from its booking (pre-0018 rows)", () => {
    const dto = toCourseWithStudent({
      ...base,
      subject: null,
      bookings: [{ subject: { id: "sub1", name: "Balance Bike" } }],
    });
    expect(dto.subject).toEqual({ id: "sub1", name: "Balance Bike" });
  });
});

describe("toTeacherDTO — dangling teacher_subjects row (TASK-029, availability 500 fix)", () => {
  test("skips a teacher_subjects row whose joined subject is missing instead of throwing", () => {
    const dto = toTeacherDTO({
      id: "t2",
      name: "Bob",
      nickname: "บ๊อบ",
      type: "PART_TIME",
      active: true,
      teacherSubjects: [
        { subject: { id: "s1", name: "Balance Bike" } },
        { subject: null }, // dangling row — used to crash `ts.subject.id`
        { subject: undefined },
      ],
    });
    expect(dto.subjects).toEqual([{ id: "s1", name: "Balance Bike" }]);
  });
});

// ───────── SPEC-059 / TASK-171 (REQ-063 req 8 / AC-10) — the discount reaches the record ─────────
//
// The bug this feature has already produced twice was a value that existed in one layer and never arrived in
// the next (satang-vs-baht, then a field dropped from the request body). Both were type-clean and
// screen-plausible. So these assert the DTO's actual shape, including the unit the value travels in.
const bookingRow = (extra: Record<string, unknown> = {}) => ({
  id: "b1",
  date: "2026-08-23",
  startTime: "10:00:00",
  endTime: "11:00:00",
  bookingType: "FIRST_TRIAL",
  status: "CONFIRMED",
  student: { id: "s1", name: "เด็กชายเอ", nickname: "เอ" },
  teacher: { id: "t1", name: "Alice", nickname: "อลิซ", type: "FULL_TIME" },
  subject: { id: "sub1", name: "Bike" },
  ...extra,
});

describe("toBookingDTO discount (TASK-171)", () => {
  test("a booking with no discount carries `null` — not an empty object", () => {
    // An absent discount and a discount of nothing must not look alike on screen.
    expect(toBookingDTO(bookingRow()).discount).toBeNull();
  });

  test("🔴 a captured discount travels as the HUMAN number, exactly as stored (TASK-168's contract)", () => {
    const dto = toBookingDTO(
      bookingRow({
        discountKind: "BAHT",
        discountValue: 391, // ฿391 — NOT 39100. A conversion here would be a second unit on the wire.
        discountReason: "โปรวันแม่",
        discountActor: "admin",
      }),
    );
    expect(dto.discount).toEqual({ kind: "BAHT", value: 391, reason: "โปรวันแม่", actor: "admin" });
  });

  test("a percent discount is carried the same way", () => {
    const dto = toBookingDTO(bookingRow({ discountKind: "PERCENT", discountValue: 10, discountReason: "x" }));
    expect(dto.discount).toEqual({ kind: "PERCENT", value: 10, reason: "x", actor: null });
  });

  test("the rest of the DTO is unchanged (regression)", () => {
    const plain = toBookingDTO(bookingRow());
    const discounted = toBookingDTO(bookingRow({ discountKind: "PERCENT", discountValue: 10 }));
    const { discount: _a, ...restPlain } = plain as any;
    const { discount: _b, ...restDiscounted } = discounted as any;
    expect(restDiscounted).toEqual(restPlain);
  });
});

// ───── SPEC-061 / TASK-173 (REQ-065) — `1st Trial` must not be pickable as a program ─────
//
// `active = false` means "not something to choose" — enforced once, in the field every picker renders, rather
// than filtered out of one dropdown and met again on the next screen someone builds. The pair of tests that
// matters is filter-in-the-picker / no-filter-on-the-read: the row is deactivated precisely so history keeps
// naming it.
const teacherRow = (subjects: Array<{ id: string; name: string; active?: boolean }>) => ({
  id: "t1",
  name: "Alice",
  nickname: "อลิซ",
  type: "FULL_TIME",
  active: true,
  teacherSubjects: subjects.map((subject) => ({ subject })),
});

describe("subjectOptions drops inactive subjects (TASK-173)", () => {
  test("🔴 an inactive subject is absent from the picker; active ones are untouched", () => {
    const dto = toTeacherDTO(
      teacherRow([
        { id: "s1", name: "Bike", active: true },
        { id: "trial", name: "1st Trial", active: false },
        { id: "s2", name: "Onewheel", active: true },
      ]),
    );
    expect(dto.subjects.map((s: { id: string }) => s.id)).toEqual(["s1", "s2"]);
  });

  test("a subject with no `active` field is kept — absent is not inactive", () => {
    // Rows loaded by a query that didn't select `active` must not silently vanish from every picker.
    expect(toTeacherDTO(teacherRow([{ id: "s1", name: "Bike" }])).subjects).toHaveLength(1);
  });

  test("the dangling-link guard still holds (TASK-029 regression)", () => {
    const dto = toTeacherDTO({ id: "t1", teacherSubjects: [{ subject: null }, { subject: { id: "s1", name: "Bike", active: true } }] });
    expect(dto.subjects.map((s: { id: string }) => s.id)).toEqual(["s1"]);
  });

  test("🔴 AC-3 — a booking on an inactive subject still renders its name", () => {
    // The whole reason the row is deactivated instead of deleted: last month's `1st Trial` bookings must keep
    // saying what they were. Nothing on the read path may consult `active`.
    const dto = toBookingDTO(bookingRow({ subject: { id: "trial", name: "1st Trial", active: false } }));
    expect(dto.subject).toEqual({ id: "trial", name: "1st Trial" });
  });
});
