// REQ-078 DEF-3 / TASK-236 — the bookings list counted อื่นๆ rows and then inner-joined them away.
//
// 🔴 The defect in one sentence: **a join is a FILTER the moment its column can be null.** `0029` made
// `student_id` and `subject_id` nullable, which silently turned two long-standing lookups into a filter — while
// the `total` query, which has no joins at all, kept counting the rows the page then refused to render. "2
// found", zero rows.
//
// The query needs a database, so what is pinned here is the shape that made it possible and the invariant that
// keeps it fixed. `.toSQL()` compiles offline and executes nothing, so the emitted SQL is real evidence rather
// than a source grep — the same technique TASK-229 used for its NULL trap.
import { describe, expect, test } from "bun:test";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, coursePackages, students, subjects, teachers } from "../db/schema";
import { readSrc } from "../lib/read-src";
import { toBookingDTO } from "../db/mappers";

const SVC = readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text());
const FN = (() => {
  const at = SVC.indexOf("const rows = await db\n    .select({ b: bookings, s: students, t: teachers");
  const rest = SVC.slice(at);
  return rest.slice(0, rest.indexOf("\n  return {"));
})();
/** Comments stripped — every assertion below is about what the QUERY does, not what it says about itself. */
const code = FN.replace(/^\s*\/\/.*$/gm, "");
/** The `q` block sits above the row query, so it needs its own slice. */
const SEARCH = SVC.slice(SVC.indexOf("if (f.q) {\n    const ors"), SVC.indexOf("const cond ="));

describe("🔴 DEF-3 — the two joins that became filters", () => {
  test("`students` and `subjects` are LEFT joined; a row with neither still comes back", () => {
    expect(code).toContain("leftJoin(students, eq(students.id, bookings.studentId))");
    expect(code).toContain("leftJoin(subjects, eq(subjects.id, bookings.subjectId))");
    expect(code).not.toContain("innerJoin(students");
    expect(code).not.toContain("innerJoin(subjects");
  });

  test("`teachers` stays INNER — `teacher_id` is still NOT NULL, so it is an integrity assertion", () => {
    // Not an oversight and not symmetry for its own sake: a booking with no resolvable teacher is a broken
    // row, and it should not quietly render.
    expect(code).toContain("innerJoin(teachers, eq(teachers.id, bookings.teacherId))");
  });

  test("🔑 LEFT vs INNER is the whole defect — the emitted SQL proves the difference", () => {
    const left = db
      .select({ b: bookings })
      .from(bookings)
      .leftJoin(students, eq(students.id, bookings.studentId))
      .toSQL()
      .sql.toLowerCase();
    const inner = db
      .select({ b: bookings })
      .from(bookings)
      .innerJoin(students, eq(students.id, bookings.studentId))
      .toSQL()
      .sql.toLowerCase();
    expect(left).toContain("left join");
    expect(inner).toContain("inner join");
    // The row set differs only for a NULL `student_id` — which is exactly, and only, an อื่นๆ booking.
    expect(left).not.toContain("inner join");
  });
});

describe("⚖️ the invariant that must hold: `total` and the rows answer the same question", () => {
  test("only `cond` narrows the set — and both queries use it", () => {
    // The count query has no joins. So the row query must not filter either, or `total` becomes a number the
    // page cannot show. This is the property the old comment claimed and `0029` quietly broke.
    expect(code).toContain(".where(cond)");
    const totalQuery = FN.slice(FN.indexOf("const [{ value: total }]"), FN.indexOf("const rented"));
    expect(totalQuery).toContain(".from(bookings)");
    expect(totalQuery).toContain(".where(cond)");
    expect(totalQuery).not.toContain("Join(");
  });

  test("🔴 no INNER join on a nullable booking column survives in this query", () => {
    // The generalisable rule, asserted rather than remembered: `student_id`, `subject_id` and `course_id` are
    // all nullable now, so none of them may be inner-joined here.
    for (const nullable of ["bookings.studentId", "bookings.subjectId", "bookings.courseId"]) {
      expect(code).not.toMatch(new RegExp(`innerJoin\\([^)]*${nullable.replace(".", "\\.")}`));
    }
  });

  test("the false comment is corrected, not deleted — and states the invariant it must hold", () => {
    // The retired line claimed nothing was filtered out, so `total` always matched the row set. True when
    // written, false since `0029`. A comment asserting an invariant the code no longer holds is worse than no
    // comment (TASK-223's lesson, applied to the very thing it was written about).
    //
    // ⚠️ The old wording must be absent from the file entirely — not even quoted while explaining itself, or a
    // grep hands the next reader the retired claim out of context. That trap caught me on TASK-223 and it
    // caught me again here, in my own replacement comment.
    expect(FN).not.toContain("Pure sort: nothing is filtered out");
    expect(FN).toContain("must answer the same question");
    expect(FN).toContain("must be a LEFT join");
  });
});

describe("the search path — an อื่นๆ booking can be found by its title", () => {
  test("the typed title joins the OR, so the row is findable by the only name it has", () => {
    // Decision recorded on the line: an อื่นๆ booking has neither a student nor a program, so without this it
    // matches nothing — and "searched and found nothing" is indistinguishable from "cannot be searched".
    expect(SEARCH).toContain("ilike(bookings.otherTitle,");
  });

  test("it is one OR on an existing column — no second query, and the four lesson types are unaffected", () => {
    const search = SVC.slice(SVC.indexOf("if (f.q) {\n    const ors"), SVC.indexOf("const cond ="));
    expect(search).not.toContain("await");
    // `other_title` is null for every lesson type, so the clause can never match one.
    const emitted = db
      .select({ id: bookings.id })
      .from(bookings)
      .where(or(ilike(bookings.otherTitle, "%x%")))
      .toSQL()
      .sql.toLowerCase();
    expect(emitted).toContain("other_title");
    expect(emitted).toContain("ilike");
  });
});

describe("🔴 the SECOND finding of the sweep — the hand-built row was missing `additionalTeachers`", () => {
  test("the page batches them, and the row hands them to the DTO", () => {
    // Same root cause as DEF-3, different symptom: a hand-written `select()` carries only what its author
    // listed. The calendar (relational reader) showed every teacher; this list showed one.
    expect(code).toContain("additionalTeachersByBooking(rows.map((r) => r.b.id))");
    expect(SVC).toContain("additionalTeachers: extraTeachers.get(r.b.id) ?? []");
  });

  test("one query for the page, not one per row — the same rule as the rentals beside it", () => {
    const loader = (() => {
      const at = SVC.indexOf("async function additionalTeachersByBooking");
      const rest = SVC.slice(at);
      return rest.slice(0, rest.indexOf("\n}\n") + 2);
    })();
    expect(loader).toContain("inArray(bookingTeachers.bookingId, bookingIds)");
    expect(loader).not.toMatch(/for \([^)]*\) \{[\s\S]*await/); // no query inside a loop
  });

  test("the shape it produces is what `toBookingDTO` already consumes — one DTO, two sources", () => {
    // If the loader's shape drifted from the relation's, the list and the calendar would disagree again.
    const dto = toBookingDTO({
      id: "b1",
      date: "2026-09-10",
      startTime: "10:00:00",
      endTime: "11:00:00",
      bookingType: "OTHER",
      status: "PENDING",
      otherTitle: "ประชุมทีม",
      student: null,
      subject: null,
      teacher: { id: "t1", name: "ครูหนึ่ง", nickname: "หนึ่ง", type: "FULL_TIME" },
      additionalTeachers: [{ teacher: { id: "t2", name: "ครูสอง", nickname: "สอง", type: "PART_TIME" } }],
    });
    expect(dto.teachers.map((t: any) => t.id)).toEqual(["t1", "t2"]);
    expect(dto.displayName).toBe("ประชุมทีม");
    expect(dto.student).toBeNull();
    expect(dto.subject).toBeNull();
  });
});

describe("regression — the four existing types are untouched", () => {
  test("a lesson row still resolves its student and program through the DTO", () => {
    const dto = toBookingDTO({
      id: "b2",
      date: "2026-09-10",
      startTime: "10:00:00",
      endTime: "11:00:00",
      bookingType: "SINGLE_SESSION",
      status: "CONFIRMED",
      student: { id: "st1", name: "เด็กชายเอ", nickname: "น้องเอ" },
      subject: { id: "s1", name: "Surfskate" },
      teacher: { id: "t1", name: "ครูหนึ่ง", nickname: "หนึ่ง", type: "FULL_TIME" },
      additionalTeachers: [],
    });
    expect(dto.student).not.toBeNull();
    expect(dto.subject).toEqual({ id: "s1", name: "Surfskate" });
    expect(dto.teachers).toHaveLength(1);
    expect(dto.displayName).toBe("น้องเอ");
  });

  test("ordering, paging and the course left-join are unchanged", () => {
    expect(code).toContain("bookingsOrderBy(f.sort ?? \"upcoming\"");
    expect(code).toContain(".limit(f.limit)");
    expect(code).toContain(".offset((f.page - 1) * f.limit)");
    expect(code).toContain("leftJoin(coursePackages, eq(coursePackages.id, bookings.courseId))");
  });

  test("the select list still carries the same five aliases the DTO is built from", () => {
    expect(code).toContain("select({ b: bookings, s: students, t: teachers, sub: subjects, c: coursePackages })");
  });
});
