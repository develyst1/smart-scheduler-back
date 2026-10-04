// TASK-645 (REQ-113) — the SEAM: an attended last session still carries `courseLast: true`.
//
// 🔴 This defect lived on a seam, which is why three correct-looking places were each individually wrong: the QUERY never
//    fetched ATTENDED rows · the grouping took the max over LIVE only · the predicate refused a delivered row. **Fixing any one
//    of them changes nothing**, and each site's own unit test would have stayed green.
// ⇒ this file drives the REAL query function over a fake executor that APPLIES its WHERE, feeds the result through the REAL
//    predicate, and renders the REAL DTO. 🔑 The status filter is exercised, not assumed.
// ⚠️ What it does NOT cover, said rather than implied: the wiring from `getCalendar` into `isCourseLast` is pinned AT SOURCE in
//    `course-last-badge-req089` (one grouped read before the loop, both readers). This covers the three sites and the DTO.
import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { lastLessonDatesForCourses } from "./scheduler.service";
import { isCourseLast } from "../lib/course-plan";
import { toBookingDTO } from "../db/mappers";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const dialect = new PgDialect();
const C = "c1";
const W = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
const row = (date: string, status: string) => ({ courseId: C, date, status });

/**
 * An executor that really applies the query's own `WHERE` — the statuses it binds are read out of the condition, so a filter
 * that excludes ATTENDED returns nothing, exactly as the live one did.
 */
const exec = (rows: Array<{ courseId: string; date: string; status: string }>) => ({
  select: () => ({
    from: () => ({
      where: async (cond: any) => {
        const { params } = dialect.sqlToQuery(cond);
        const bound = new Set(params.map(String));
        return rows.filter((r) => bound.has(r.status) && bound.has(r.courseId));
      },
    }),
  }),
});
const dto = (date: string, status: string, last: ReadonlyMap<string, string | null>) => {
  const r = { id: `b-${date}`, courseId: C, date, status, bookingType: "COURSE_PACKAGE", startTime: "10:00", endTime: "11:00", teacher: { id: "t", name: "T", nickname: "T", type: "FULL_TIME" }, student: { id: "s", name: "S" } };
  return toBookingDTO(r, { courseLast: isCourseLast(r, last) });
};

describe("⭐ TASK-645 — the SEAM: query → grouping → predicate → DTO, by value", () => {
  test("🔴 THE DEFECT'S OWN CASE: an all-attended course — the last ATTENDED row reaches the DTO as `courseLast: true`", async () => {
    const rows = [row(W(1), "ATTENDED"), row(W(2), "ATTENDED"), row(W(3), "ATTENDED")];
    const last = await lastLessonDatesForCourses([C], exec(rows));
    expect(last.get(C)).toBe(W(3)); // 🔑 the query FETCHED them — the third site, where no corrected date could have helped
    expect(rows.map((r) => dto(r.date, r.status, last).courseLast)).toEqual([false, false, true]);
  });

  test("🔴 ruling 2 — a NO_SHOW on the final date still carries the badge", async () => {
    const rows = [row(W(1), "ATTENDED"), row(W(2), "NO_SHOW")];
    const last = await lastLessonDatesForCourses([C], exec(rows));
    expect(last.get(C)).toBe(W(2));
    expect(dto(W(2), "NO_SHOW", last).courseLast).toBe(true);
  });

  test("🚫 a SICK_LEAVE dated last never reaches the badge — the query does not even fetch it, and the predicate refuses it", async () => {
    const rows = [row(W(1), "ATTENDED"), row(W(2), "CONFIRMED"), row(W(3), "SICK_LEAVE")];
    const last = await lastLessonDatesForCourses([C], exec(rows));
    expect(last.get(C)).toBe(W(2)); // the leave is not a lesson…
    expect(dto(W(3), "SICK_LEAVE", last).courseLast).toBe(false);
    expect(dto(W(2), "CONFIRMED", last).courseLast).toBe(true); // …and the lesson before it is last
  });

  test("📌 a make-up after the last attended session moves the badge to the make-up", async () => {
    const rows = [row(W(1), "ATTENDED"), row(W(2), "SICK_LEAVE"), row(W(3), "ATTENDED"), row(W(4), "EXTENDED")];
    const last = await lastLessonDatesForCourses([C], exec(rows));
    expect(last.get(C)).toBe(W(4));
    expect(dto(W(3), "ATTENDED", last).courseLast).toBe(false);
    expect(dto(W(4), "EXTENDED", last).courseLast).toBe(true);
  });

  test("🚫 a non-course row is never last, even dated on the course's last lesson", async () => {
    const last = await lastLessonDatesForCourses([C], exec([row(W(1), "ATTENDED")]));
    const single = { id: "x", courseId: null, date: W(1), status: "CONFIRMED", bookingType: "SINGLE_SESSION", startTime: "10:00", endTime: "11:00", teacher: { id: "t", name: "T", nickname: "T", type: "FULL_TIME" }, student: { id: "s", name: "S" } };
    expect(toBookingDTO(single, { courseLast: isCourseLast(single, last) }).courseLast).toBe(false);
  });

  test("✅ the empty read is unchanged — no course ids ⇒ no query, an empty map", async () => {
    expect([...(await lastLessonDatesForCourses([], exec([row(W(1), "ATTENDED")])))]).toEqual([]);
  });
});
