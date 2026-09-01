// SPEC-070 / TASK-224 (REQ-078) — the `OTHER` booking type: อื่นๆ on the calendar.
//
// Two kinds of claim are pinned here, and they are not the same kind of evidence:
//   · **Contract**: the zod schema and `toBookingDTO` are callable without a database, so what they accept,
//     refuse and compute is tested by CALLING them.
//   · **Source claims**: the freelance guard and the migration live inside a transaction with no pure seam, so
//     they are asserted at the source — the same way TASK-180's day-end job is.
//
// 🔴 The riskiest thing in this task is not the new type. It is **AC-14**: four booking types that already work
// must come out byte-identical now that their student/subject columns are no longer NOT NULL. Half of this file
// is about them.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { createBooking } from "../validation";
import { toBookingDTO, bookingTeachers } from "../db/mappers";

const SVC = readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text());
const SCHEMA = await Bun.file(new URL("../db/schema.ts", import.meta.url)).text();
const SQL = await Bun.file(new URL("../../drizzle/0029_other_booking_type.sql", import.meta.url)).text();

const base = {
  teacherId: "11111111-1111-4111-8111-111111111111",
  date: "2026-09-10",
  startTime: "10:00",
};
const student = { id: "22222222-2222-4222-8222-222222222222" };
const subjectId = "33333333-3333-4333-8333-333333333333";
const teacher2 = "44444444-4444-4444-8444-444444444444";
// The two lesson types that need no entitlement id, so a test about student/subject is not secretly about those.
const SIMPLE = ["FIRST_TRIAL", "SINGLE_SESSION"] as const;

// A booking row as the relational query returns it, so the DTO is exercised the way it is really called.
function row(over: Record<string, any> = {}) {
  return {
    id: "b1",
    date: "2026-09-10",
    startTime: "10:00:00",
    endTime: "11:00:00",
    bookingType: "OTHER",
    status: "PENDING",
    student: { id: "st1", name: "เด็กชายเอ", nickname: "น้องเอ" },
    teacher: { id: "t1", name: "ครูหนึ่ง", nickname: "หนึ่ง", type: "FULL_TIME" },
    subject: { id: "s1", name: "Surfskate" },
    ...over,
  };
}

describe("🔴 AC-14 — the four LESSON types keep every guard they had", () => {
  test("a missing STUDENT is still refused, per type — the column stopped enforcing it, the contract did not", () => {
    // `0029` dropped `student_id`'s NOT NULL so `OTHER` can omit it. Without the refine, relaxing the schema
    // for one type would silently let a 1HR be booked with no student — a change nobody asked for, for free.
    for (const bookingType of SIMPLE) {
      const r = createBooking.safeParse({ ...base, subjectId, bookingType });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("ต้องระบุนักเรียน");
    }
  });

  test("a missing PROGRAM is still refused, per type", () => {
    for (const bookingType of SIMPLE) {
      const r = createBooking.safeParse({ ...base, student, bookingType });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("ต้องเลือกโปรแกรม");
    }
  });

  test("a complete booking of each lesson type still parses — the guards did not become a wall", () => {
    // The failure mode that would make the two tests above pass for the wrong reason.
    const ok = (o: Record<string, unknown>) =>
      createBooking.safeParse({ ...base, student, subjectId, ...o }).success;
    expect(ok({ bookingType: "FIRST_TRIAL" })).toBe(true);
    expect(ok({ bookingType: "SINGLE_SESSION" })).toBe(true);
    expect(ok({ bookingType: "VOUCHER", voucherId: student.id })).toBe(true);
    expect(ok({ bookingType: "COURSE_PACKAGE", courseId: student.id })).toBe(true);
  });

  test("🔴 AC-20 — the four lesson types REFUSE every อื่นๆ field, rather than ignoring it", () => {
    // Silently dropping them is how `other_title` ends up on a course session nothing renders it for, and how
    // "the other four take exactly one teacher" stops being true of the DATA while still being true on screen.
    for (const extra of [
      { otherTitle: "ประชุม" },
      { otherPriceMinor: 50000 },
      { otherPriceItemId: subjectId },
      { additionalTeacherIds: [teacher2] },
    ]) {
      for (const bookingType of SIMPLE) {
        expect(createBooking.safeParse({ ...base, student, subjectId, bookingType, ...extra }).success).toBe(false);
      }
    }
  });

  test("their DTO is unchanged: `student` and `subject` are still objects, `teachers` has exactly one", () => {
    const dto = toBookingDTO(row({ bookingType: "SINGLE_SESSION" }));
    expect(dto.student).not.toBeNull();
    expect(dto.subject).toEqual({ id: "s1", name: "Surfskate" });
    expect(dto.teachers).toHaveLength(1);
    expect(dto.title).toBeNull();
  });
});

describe("an อื่นๆ booking — what it may and may not be", () => {
  test("saves WITHOUT a student when a title is given", () => {
    expect(createBooking.safeParse({ ...base, bookingType: "OTHER", otherTitle: "ปิดปรับปรุงลาน" }).success).toBe(true);
  });

  test("saves WITH a student too — อื่นๆ is not the same as 'nobody'", () => {
    expect(createBooking.safeParse({ ...base, student, bookingType: "OTHER" }).success).toBe(true);
  });

  test("🔴 no student AND no title → refused with the owner's message; nothing to write", () => {
    const r = createBooking.safeParse({ ...base, bookingType: "OTHER" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("กรุณาระบุชื่อรายการ");
  });

  test("a blank / whitespace title does not count as a title", () => {
    for (const otherTitle of ["", "   "]) {
      expect(createBooking.safeParse({ ...base, bookingType: "OTHER", otherTitle }).success).toBe(false);
    }
  });

  test("🔴 AC-12 — both price sources at once is REFUSED, never clamped and never picked for the user", () => {
    const r = createBooking.safeParse({
      ...base,
      bookingType: "OTHER",
      otherTitle: "ประชุม",
      otherPriceMinor: 50000,
      otherPriceItemId: subjectId,
    });
    expect(r.success).toBe(false);
  });

  test("an amount of 0, a negative or a non-integer is refused — a charge of nothing is not a charge", () => {
    for (const otherPriceMinor of [0, -1, 1.5, Number.NaN]) {
      expect(
        createBooking.safeParse({ ...base, bookingType: "OTHER", otherTitle: "ประชุม", otherPriceMinor }).success,
      ).toBe(false);
    }
    expect(
      createBooking.safeParse({ ...base, bookingType: "OTHER", otherTitle: "ประชุม", otherPriceMinor: 1 }).success,
    ).toBe(true);
  });

  test("🔴 AC-19 — no teacher is refused; and the extra teachers must be a sane list", () => {
    expect(
      createBooking.safeParse({
        date: base.date,
        startTime: base.startTime,
        bookingType: "OTHER",
        otherTitle: "ประชุม",
      }).success,
    ).toBe(false);
    const other = { ...base, bookingType: "OTHER", otherTitle: "ประชุม" };
    expect(createBooking.safeParse({ ...other, additionalTeacherIds: [teacher2, teacher2] }).success).toBe(false);
    expect(createBooking.safeParse({ ...other, additionalTeacherIds: [base.teacherId] }).success).toBe(false);
    expect(createBooking.safeParse({ ...other, additionalTeacherIds: [teacher2] }).success).toBe(true);
  });

  test("a discount is still refused on อื่นๆ — by the rule that already existed, not a second one", () => {
    // `captureBookingDiscount` refuses anything that is not FIRST_TRIAL / SINGLE_SESSION, so `OTHER` is
    // excluded by construction. Pinned so a future edit to that list cannot let it in unnoticed.
    expect(SVC).toContain('input.bookingType !== "FIRST_TRIAL" && input.bookingType !== "SINGLE_SESSION"');
  });
});

describe("🔴 AC-10 — one `displayName`, computed once, never blank and never the word อื่นๆ", () => {
  test("a titled booking shows its title", () => {
    expect(toBookingDTO(row({ otherTitle: "ประชุมทีม", student: null, subject: null })).displayName).toBe("ประชุมทีม");
  });

  test("every other type shows the student's nickname — unchanged behaviour, one code path", () => {
    expect(toBookingDTO(row({ bookingType: "SINGLE_SESSION" })).displayName).toBe("น้องเอ");
  });

  test("no nickname falls back to the full name, not to blank", () => {
    expect(toBookingDTO(row({ student: { id: "st1", name: "เด็กชายเอ", nickname: null } })).displayName).toBe(
      "เด็กชายเอ",
    );
  });

  test("🔴 it is never empty for anything validation lets through, and never renders the word อื่นๆ", () => {
    // The saveable shapes are exactly two: a student, or a title. Both produce a name.
    for (const r of [row({ otherTitle: "ปิดปรับปรุงลาน", student: null, subject: null }), row()]) {
      const dto = toBookingDTO(r);
      expect(dto.displayName).not.toBe("");
      expect(dto.displayName).not.toBe("อื่นๆ");
    }
  });

  test("a title WINS over a student's nickname — the person typed it for this booking", () => {
    expect(toBookingDTO(row({ otherTitle: "ประชุมกับผู้ปกครอง" })).displayName).toBe("ประชุมกับผู้ปกครอง");
  });
});

describe("🚫 no placeholder program, no placeholder student", () => {
  test("`subject` and `student` are NULL, not a fabricated row", () => {
    // REQ-065 exists because `1st Trial` sitting in `subjects` leaked into the program picker and had to be
    // filtered back out at `toTeacherDTO`. A fake อื่นๆ program would leak the same way — picker, `link-all`,
    // `price_group`.
    const dto = toBookingDTO(row({ student: null, subject: null, otherTitle: "ประชุม" }));
    expect(dto.student).toBeNull();
    expect(dto.subject).toBeNull();
  });

  test("the migration adds NO subjects row — it drops a NOT NULL instead", () => {
    expect(SQL).not.toMatch(/INSERT INTO "?subjects"?/i);
    expect(SQL).toContain('ALTER COLUMN "subject_id" DROP NOT NULL');
  });
});

describe("🔴 AC-18 — every teacher, from ONE accessor", () => {
  test("`teachers[0]` is always the row's own `teacher_id`, so the order is stable", () => {
    const dto = toBookingDTO(
      row({ additionalTeachers: [{ teacher: { id: "t2", name: "ครูสอง", nickname: "สอง", type: "PART_TIME" } }] }),
    );
    expect(dto.teachers.map((t: any) => t.id)).toEqual(["t1", "t2"]);
    expect(dto.teachers[0]!.id).toBe(dto.teacher.id);
  });

  test("every booking type carries `teachers` — length 1 with no extras, so the FE has ONE shape", () => {
    expect(toBookingDTO(row({ bookingType: "VOUCHER" })).teachers).toHaveLength(1);
    expect(bookingTeachers(row())).toHaveLength(1);
  });

  test("a half-loaded relation cannot produce a phantom teacher", () => {
    expect(bookingTeachers(row({ additionalTeachers: [{ teacher: null }, {}] }))).toHaveLength(1);
  });

  test("🔴 nothing outside the named functions touches the join table — a stray reader is a second answer", () => {
    // The rule is not "one touch point"; it is **one place that COMPUTES the teacher list**. Three functions
    // touch the table, and they are different kinds of thing:
    //   · `attachAdditionalTeachers`  — writes.
    //   · `assignedTeacherIds`        — the id-level ACCESSOR (LINE paths hold a bare row in a transaction).
    //   · `additionalTeachersByBooking` — a LOADER (TASK-236): it batches the relation for a hand-built row
    //     so `toBookingDTO` cannot tell that source from the relational reader's. It must NOT prepend the
    //     primary teacher — the moment it did, it would be a second answer to "who teaches this booking",
    //     which is the whole failure mode this test exists for.
    // A FOURTH touch point, or a loader that starts composing the list itself, fails here.
    const code = SVC.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "");
    const body = (decl: string) => {
      const rest = code.slice(code.indexOf(decl));
      return rest.slice(0, rest.indexOf("\n}\n") + 2);
    };
    const writer = body("async function attachAdditionalTeachers");
    const reader = body("async function assignedTeacherIds");
    const loader = body("async function additionalTeachersByBooking");
    expect(writer).toContain("insert(bookingTeachers)");
    expect(reader).toContain("from(bookingTeachers)");
    expect(loader).toContain("from(bookingTeachers)");
    // 🔴 The loader hands back ONLY the extras, shaped like the relation. It never composes the full list —
    // so it never looks at the booking's own `teacher_id`, which is the primary the accessor puts first.
    expect(loader).not.toContain("bookings.teacherId");
    expect(loader).not.toContain("from(bookings)");
    expect(loader).not.toContain("primary");
    const count = (s: string) => s.split("bookingTeachers").length - 1;
    // Every mention in the file is the import (1), or inside one of those three functions.
    expect(count(code)).toBe(1 + count(writer) + count(reader) + count(loader));
  });

  test("the relation is loaded in the SHARED relation set, not opted into per query", () => {
    expect(SVC).toContain("additionalTeachers: { with: { teacher: true } }");
    expect(SVC).toContain("with: withBookingRelations");
  });
});

describe("🔴 AC-21 — an อื่นๆ booking draws NO freelance budget, from any teacher", () => {
  const fn = (() => {
    const at = SVC.indexOf("async function reconcileBookingHolds");
    const rest = SVC.slice(at);
    return rest.slice(0, rest.indexOf("\n}\n") + 2);
  })();

  test("the guard is INSIDE `reconcileBookingHolds`, before anything is read or written", () => {
    // Six call sites. Guarding six is how five stay right and one drifts.
    expect(fn).toContain('if (booking?.bookingType === "OTHER") return;');
    expect(fn.indexOf('bookingType === "OTHER"')).toBeLessThan(fn.indexOf("boMovement"));
  });

  test("🔴 it returns before any movement is written — the DoD asserts the ABSENCE of an `fl:` row", () => {
    const beforeGuard = fn.slice(0, fn.indexOf('bookingType === "OTHER"'));
    for (const write of ["applyHoldMove", "insert("]) expect(beforeGuard).not.toContain(write);
  });

  test("🚫 `heldTarget` is untouched — it answers a different question and is still right", () => {
    // It says what a STATUS holds. "Does this booking hold at all" is a booking-type question and belongs
    // where the booking is known. Editing it would change the four existing types' holds.
    const at = SVC.indexOf("function heldTarget");
    expect(SVC.slice(at, at + 600)).not.toContain("OTHER");
  });
});

describe("the migration `0029` — the two traps it must not fall into", () => {
  test("🔴 TRAP 1 — no STATEMENT uses 'OTHER'; ADD VALUE shares its transaction with the whole run", () => {
    // `drizzle-kit migrate` wraps every pending migration in ONE transaction, and a new enum value cannot be
    // used in the transaction that added it. No backfill, no CHECK naming it, no seed.
    //
    // Comments are stripped first: the file deliberately EXPLAINS this trap, and a test that read prose would
    // either fail on the explanation or pass on a comment. Only the statements are evidence.
    const statements = SQL.replace(/^\s*--.*$/gm, "");
    expect(statements).toContain("ADD VALUE IF NOT EXISTS 'OTHER'");
    expect(statements.split("'OTHER'")).toHaveLength(2); // exactly one occurrence: the ADD VALUE itself
  });

  test("🔴 TRAP 2 — the witness is a CHECK, because DROP NOT NULL is invisible to an existence probe", () => {
    // "Does `student_id` exist?" is true before AND after, so a column probe would make an un-migrated box
    // look identical to a migrated one — how `0022` hid and took the calendar down.
    expect(SQL).toContain('ADD CONSTRAINT "booking_other_price_chk"');
    expect(SCHEMA).toContain('"booking_other_price_chk"');
  });

  test("the join table cascades from the booking, and restricts on the teacher", () => {
    // CASCADE is what makes AC-18's "cancelling removes it everywhere" free: there is still ONE booking row.
    expect(SQL).toContain('REFERENCES "bookings"("id") ON DELETE CASCADE');
    expect(SQL).toContain('REFERENCES "teachers"("id") ON DELETE RESTRICT');
    expect(SQL).toContain('PRIMARY KEY ("booking_id", "teacher_id")');
  });

  test("`bookings.teacher_id` stays NOT NULL — every existing reader, index and hold is untouched", () => {
    expect(SQL).not.toContain('"teacher_id" DROP NOT NULL');
    expect(SCHEMA).toContain('teacherId: uuid("teacher_id")');
  });
});
