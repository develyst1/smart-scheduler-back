// TASK-366 (`REQ-089 item 5`) — `courseLast: boolean` on every calendar booking DTO: `true` iff the row is a
// COURSE row, LIVE, dated on `deriveLiveEndDate` of its course — the same function, no second rule. The rule is
// pure (`liveEndDateByCourse` + `isCourseLast`) so every DoD case is pinned with rows; the ONE grouped read and
// the two wiring sites are pinned at the source, the way `hasRental` (TASK-190) is.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COURSE_LIVE_STATUSES, deriveLiveEndDate, isCourseLast, liveEndDateByCourse } from "./course-plan";
import { toBookingDTO } from "../db/mappers";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return s.slice(a, b);
};

const W = (n: number) => `2026-10-${String(n).padStart(2, "0")}`; // week n ⇒ Oct n (dates only need to order)
const row = (courseId: string | null, date: string, status: string, bookingType = "COURSE_PACKAGE") => ({ courseId, date, status, bookingType });

describe("🔑 the rule — DoD cases with rows", () => {
  test("a size-4 course with one absence ⇒ the make-up (week 5) is last, week 4 is not", () => {
    const rows = [row("c", W(1), "ATTENDED"), row("c", W(2), "SICK_LEAVE"), row("c", W(3), "CONFIRMED"), row("c", W(4), "CONFIRMED"), row("c", W(5), "EXTENDED")];
    const last = liveEndDateByCourse(rows);
    expect(last.get("c")).toBe(W(5));
    expect(last.get("c")).toBe(deriveLiveEndDate(rows)); // the SAME function's answer
    expect(rows.map((r) => isCourseLast(r, last))).toEqual([false, false, false, false, true]);
  });

  test("a course with a CANCELLED last row ⇒ the previous live row is last", () => {
    const rows = [row("c", W(1), "CONFIRMED"), row("c", W(2), "CONFIRMED"), row("c", W(3), "CANCELLED")];
    const last = liveEndDateByCourse(rows);
    expect(last.get("c")).toBe(W(2));
    expect(rows.map((r) => isCourseLast(r, last))).toEqual([false, true, false]);
  });

  test("a single-session booking ⇒ false — even one dated on a course's end (it is not a course row)", () => {
    const rows = [row("c", W(1), "CONFIRMED"), row(null, W(1), "CONFIRMED", "SINGLE_SESSION"), row(null, W(1), "CONFIRMED", "VOUCHER"), row(null, W(1), "CONFIRMED", "OTHER")];
    const last = liveEndDateByCourse(rows);
    expect(rows.map((r) => isCourseLast(r, last))).toEqual([true, false, false, false]);
  });

  test("a SICK_LEAVE dated last ⇒ false, and the live row before it ⇒ true", () => {
    const rows = [row("c", W(1), "CONFIRMED"), row("c", W(2), "CONFIRMED"), row("c", W(3), "SICK_LEAVE")];
    const last = liveEndDateByCourse(rows);
    expect(last.get("c")).toBe(W(2));
    expect(rows.map((r) => isCourseLast(r, last))).toEqual([false, true, false]);
  });

  test("🔑 the badge leaves the past cell at attendance — a delivered last means NO live end, so no row is last", () => {
    const rows = [row("c", W(1), "ATTENDED"), row("c", W(2), "ATTENDED"), row("c", W(3), "ATTENDED"), row("c", W(4), "ATTENDED")];
    const last = liveEndDateByCourse(rows);
    expect(last.get("c")).toBeNull();
    expect(rows.some((r) => isCourseLast(r, last))).toBe(false);
    // …and while the last is still ahead, it is last.
    const ahead = [...rows.slice(0, 3), row("c", W(4), "CONFIRMED")];
    expect(isCourseLast(ahead[3]!, liveEndDateByCourse(ahead))).toBe(true);
  });

  test("many courses in one range, grouped once — each answers for itself; a course never in the read answers false", () => {
    const rows = [row("a", W(1), "CONFIRMED"), row("b", W(1), "CONFIRMED"), row("a", W(2), "EXTENDED"), row("b", W(3), "CONFIRMED"), row("b", W(4), "PENDING")];
    const last = liveEndDateByCourse(rows);
    expect([...last]).toEqual([["a", W(2)], ["b", W(4)]]);
    expect(isCourseLast(row("z", W(1), "CONFIRMED"), last)).toBe(false);
    expect(isCourseLast(row("a", W(2), "EXTENDED"), last)).toBe(true);
  });

  test("the live set is COURSE_LIVE_STATUSES — PENDING, CONFIRMED, EXTENDED — nothing else counts as last", () => {
    for (const s of COURSE_LIVE_STATUSES) expect(isCourseLast(row("c", W(1), s), new Map([["c", W(1)]]))).toBe(true);
    for (const s of ["ATTENDED", "NO_SHOW", "SICK_LEAVE", "CANCELLED", "PAUSED"]) expect(isCourseLast(row("c", W(1), s), new Map([["c", W(1)]]))).toBe(false);
  });
});

describe("🔑 the DTO — one shape, `false` where nothing computes it (the `hasRental` convention)", () => {
  const base = { id: "b", date: W(1), startTime: "10:00", endTime: "11:00", bookingType: "COURSE_PACKAGE", status: "CONFIRMED", teacher: { id: "t", name: "T", nickname: "T", type: "FULL_TIME" }, student: { id: "s", name: "S" } };
  test("passed in ⇒ carried; absent ⇒ false", () => {
    expect(toBookingDTO(base, { courseLast: true }).courseLast).toBe(true);
    expect(toBookingDTO(base, { hasRental: true }).courseLast).toBe(false);
    expect(toBookingDTO(base).courseLast).toBe(false);
  });
});

describe("🔴 the wiring — ONE grouped read before the loop, both readers, no column (source)", () => {
  const SVC = code(src("src/services/scheduler.service.ts"));
  const READ = region(SVC, "export async function liveEndDatesForCourses(", "export async function getCalendar(");
  const CAL = region(SVC, "export async function getCalendar(", "export async function getTeachers(");
  const ONE = region(SVC, "async function loadBookingDTO(", "export async function bookingsWithRentals(");

  test("the grouped read: one select of three columns, `course_id in (…)` + the plan's own live list, then the pure grouping", () => {
    expect(READ).toContain(".select({ courseId: bookings.courseId, status: bookings.status, date: bookings.date })");
    expect(READ).toContain("inArray(bookings.courseId, ids), inArray(bookings.status, [...COURSE_LIVE_STATUSES])");
    expect(READ).toContain("return liveEndDateByCourse(rows);");
    expect(READ).toContain("if (ids.length === 0) return new Map();");
    expect((READ.match(/\.from\(bookings\)/g) ?? []).length).toBe(1);
  });

  test("the calendar resolves it ONCE, before the loop, from the range's own rows — no per-row query", () => {
    expect(CAL).toContain("const lastByCourse = await liveEndDatesForCourses(bookingRows.map((b) => b.courseId)");
    expect(CAL).toContain("courseLast: isCourseLast(row, lastByCourse)");
    // TASK-368 §5.1 added the cancelled TRAY read after this loop, so the region ends at the loop’s own close.
    const loop = region(CAL, "for (const row of bookingRows) {", "\n  }\n");
    expect(loop).not.toContain("await");
  });

  test("the single-booking read agrees with the calendar — same helper, same rule", () => {
    expect(ONE).toContain("liveEndDatesForCourses(row?.courseId ? [row.courseId] : [], exec)");
    expect(ONE).toContain("courseLast: row ? isCourseLast(row, lastByCourse) : false");
  });

  test("`deriveLiveEndDate` is untouched, `isCourseLast` calls no other 'last' rule, and `bookings` has no `course_last` column", () => {
    expect(code(src("src/lib/course-plan.ts"))).toContain("export function deriveLiveEndDate(sessions: Array<{ status: string; date: string }>): string | null {\n  const live = sessions.filter((s) => COURSE_LIVE.has(s.status)).map((s) => s.date);\n  return live.length ? live.reduce((m, d) => (d > m ? d : m)) : null;\n}");
    const PLAN = code(src("src/lib/course-plan.ts"));
    const GROUP = region(PLAN, "export function liveEndDateByCourse(", "export function isCourseLast(");
    expect(GROUP).toContain("deriveLiveEndDate(sessions)");
    expect(GROUP).not.toMatch(/reduce|Math\.max|sort\(/);
    expect(src("src/db/schema.ts")).not.toMatch(/course_last|courseLast/);
  });
});
