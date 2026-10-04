// TASK-366 (`REQ-089 item 5`) — `courseLast: boolean` on every calendar booking DTO · 🔻 TASK-645 (REQ-113) — it STAYS after
// attendance: `true` iff the row is a COURSE row, a LESSON (live **or** delivered), dated on its course's LAST LESSON.
// The rule is pure (`lastLessonDateByCourse` + `isCourseLast`) so every DoD case is pinned with rows; the ONE grouped read and
// the two wiring sites are pinned at the source, the way `hasRental` (TASK-190) is.
// ⚠️ `deriveLiveEndDate` is NOT this rule and must not become it — it is the PLAN'S DISPLAYED END, read by course history.
// Its own pin is at the bottom of this file, by value, deliberately.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COURSE_DELIVERED_STATUSES, COURSE_LIVE_STATUSES, deriveLastLessonDate, deriveLiveEndDate, isCourseLast, lastLessonDateByCourse } from "./course-plan";
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
    const last = lastLessonDateByCourse(rows);
    expect(last.get("c")).toBe(W(5));
    expect(last.get("c")).toBe(deriveLiveEndDate(rows)); // the SAME function's answer
    expect(rows.map((r) => isCourseLast(r, last))).toEqual([false, false, false, false, true]);
  });

  test("a course with a CANCELLED last row ⇒ the previous live row is last", () => {
    const rows = [row("c", W(1), "CONFIRMED"), row("c", W(2), "CONFIRMED"), row("c", W(3), "CANCELLED")];
    const last = lastLessonDateByCourse(rows);
    expect(last.get("c")).toBe(W(2));
    expect(rows.map((r) => isCourseLast(r, last))).toEqual([false, true, false]);
  });

  test("a single-session booking ⇒ false — even one dated on a course's end (it is not a course row)", () => {
    const rows = [row("c", W(1), "CONFIRMED"), row(null, W(1), "CONFIRMED", "SINGLE_SESSION"), row(null, W(1), "CONFIRMED", "VOUCHER"), row(null, W(1), "CONFIRMED", "OTHER")];
    const last = lastLessonDateByCourse(rows);
    expect(rows.map((r) => isCourseLast(r, last))).toEqual([true, false, false, false]);
  });

  test("a SICK_LEAVE dated last ⇒ false, and the live row before it ⇒ true", () => {
    const rows = [row("c", W(1), "CONFIRMED"), row("c", W(2), "CONFIRMED"), row("c", W(3), "SICK_LEAVE")];
    const last = lastLessonDateByCourse(rows);
    expect(last.get("c")).toBe(W(2));
    expect(rows.map((r) => isCourseLast(r, last))).toEqual([false, true, false]);
  });

  test("🔻 TASK-645 — CORRECTED: the badge STAYS at attendance. The last ATTENDED row is the last lesson", () => {
    // ⚠️ This test used to read: *"the badge leaves the past cell at attendance — a delivered last means NO live end, so no row
    // is last"*, and it asserted `last.get("c")` was `null` with no row badged.
    // 🔴 `REQ-089` never asked for that. TASK-366 (ours) derived the badge from the LIVE end, noticed the consequence, and
    // pinned it as if it were the requirement. **The owner has now ruled the other way (REQ-113), knowing the badge becomes
    // permanent on that cell — that is INTENDED.** Khwan's team reads it at END OF DAY to find who finished a course, which is
    // exactly when it used to disappear.
    // 🔑 Corrected rather than deleted: *a deleted assertion looks like it was never there; a corrected one records what we used
    // to believe and why we stopped.*
    const rows = [row("c", W(1), "ATTENDED"), row("c", W(2), "ATTENDED"), row("c", W(3), "ATTENDED"), row("c", W(4), "ATTENDED")];
    const last = lastLessonDateByCourse(rows);
    expect(last.get("c")).toBe(W(4));
    expect(rows.map((r) => isCourseLast(r, last))).toEqual([false, false, false, true]);
    // …and while the last is still ahead, it is still last — unchanged.
    const ahead = [...rows.slice(0, 3), row("c", W(4), "CONFIRMED")];
    expect(isCourseLast(ahead[3]!, lastLessonDateByCourse(ahead))).toBe(true);
  });

  test("🔴 REQ-113 ruling 2 — a NO_SHOW on the final date KEEPS the badge: the course has still ended", () => {
    const rows = [row("c", W(1), "ATTENDED"), row("c", W(2), "ATTENDED"), row("c", W(3), "NO_SHOW")];
    const last = lastLessonDateByCourse(rows);
    expect(last.get("c")).toBe(W(3));
    expect(rows.map((r) => isCourseLast(r, last))).toEqual([false, false, true]);
  });

  test("📌 a make-up added AFTER the last attended session MOVES the badge to the make-up — it is now the last lesson", () => {
    const rows = [row("c", W(1), "ATTENDED"), row("c", W(2), "SICK_LEAVE"), row("c", W(3), "ATTENDED"), row("c", W(4), "EXTENDED")];
    const last = lastLessonDateByCourse(rows);
    expect(last.get("c")).toBe(W(4));
    expect(rows.map((r) => isCourseLast(r, last))).toEqual([false, false, false, true]);
  });

  test("🔴 THE TRAP, pinned by value: `deriveLiveEndDate` is UNCHANGED — the plan's displayed end for an all-attended course is still null", () => {
    // 🔑 @Silver's finding: widening THIS would move the displayed end date of every course, because course history reads it.
    // **Widening a function two features read is how one fix becomes two defects.**
    const rows = [row("c", W(1), "ATTENDED"), row("c", W(2), "ATTENDED")];
    expect(deriveLiveEndDate(rows)).toBeNull();          // …exactly what it answered before TASK-645
    expect(deriveLastLessonDate(rows)).toBe(W(2));       // …while the badge's own rule answers the last lesson
    const mixed = [row("c", W(1), "ATTENDED"), row("c", W(2), "CONFIRMED"), row("c", W(3), "ATTENDED")];
    expect(deriveLiveEndDate(mixed)).toBe(W(2));         // the live end: unmoved by the delivered row after it
    expect(deriveLastLessonDate(mixed)).toBe(W(3));
  });

  test("many courses in one range, grouped once — each answers for itself; a course never in the read answers false", () => {
    const rows = [row("a", W(1), "CONFIRMED"), row("b", W(1), "CONFIRMED"), row("a", W(2), "EXTENDED"), row("b", W(3), "CONFIRMED"), row("b", W(4), "PENDING")];
    const last = lastLessonDateByCourse(rows);
    expect([...last]).toEqual([["a", W(2)], ["b", W(4)]]);
    expect(isCourseLast(row("z", W(1), "CONFIRMED"), last)).toBe(false);
    expect(isCourseLast(row("a", W(2), "EXTENDED"), last)).toBe(true);
  });

  test("🔻 TASK-645 — the lesson set is LIVE ∪ DELIVERED, derived from the two existing sets, and nothing else is last", () => {
    // 🚫 Not a hand-rolled list: the sets already exist, so the NO_SHOW ruling is satisfied BY CONSTRUCTION —
    // 🔑 a rule built from a union of existing definitions cannot drift from them.
    for (const s of [...COURSE_LIVE_STATUSES, ...COURSE_DELIVERED_STATUSES]) {
      expect({ s, last: isCourseLast(row("c", W(1), s), new Map([["c", W(1)]])) }).toEqual({ s, last: true });
    }
    // 🚫 still refused, because they are not lessons
    for (const s of ["SICK_LEAVE", "CANCELLED", "PAUSED", "PENDING_RESCHEDULE"]) {
      expect({ s, last: isCourseLast(row("c", W(1), s), new Map([["c", W(1)]])) }).toEqual({ s, last: false });
    }
  });
});

describe("🔑 the DTO — one shape, `false` where nothing computes it (TASK-190's passed-in convention)", () => {
  const base = { id: "b", date: W(1), startTime: "10:00", endTime: "11:00", bookingType: "COURSE_PACKAGE", status: "CONFIRMED", teacher: { id: "t", name: "T", nickname: "T", type: "FULL_TIME" }, student: { id: "s", name: "S" } };
  test("passed in ⇒ carried; absent ⇒ false", () => {
    expect(toBookingDTO(base, { courseLast: true }).courseLast).toBe(true);
    expect(toBookingDTO({ ...base, rental: { code: "rental-set", remark: null, paidAt: null } }).courseLast).toBe(false); // an unrelated field does not flip it
    expect(toBookingDTO(base).courseLast).toBe(false);
  });
});

describe("🔴 the wiring — ONE grouped read before the loop, both readers, no column (source)", () => {
  const SVC = code(src("src/services/scheduler.service.ts"));
  const READ = region(SVC, "export async function lastLessonDatesForCourses(", "export async function getCalendar(");
  const CAL = region(SVC, "export async function getCalendar(", "export async function getTeachers(");
  // TASK-371 removed `bookingsWithRentals` (the old end anchor); the single read now ends where the grouped read begins.
  const ONE = region(SVC, "async function loadBookingDTO(", "export async function lastLessonDatesForCourses(");

  test("the grouped read: one select of three columns, `course_id in (…)` + the plan's own live list, then the pure grouping", () => {
    expect(READ).toContain(".select({ courseId: bookings.courseId, status: bookings.status, date: bookings.date })");
    // 🔻 TASK-645 — THE THIRD SITE: this query fetched only the live statuses, so ATTENDED and NO_SHOW rows were never read and
    // no corrected date could have included them. 🔑 All three sites move together or the badge still vanishes.
    expect(READ).toContain("inArray(bookings.courseId, ids), inArray(bookings.status, [...COURSE_LESSON_STATUSES])");
    expect(READ).toContain("return lastLessonDateByCourse(rows);");
    expect(READ).toContain("if (ids.length === 0) return new Map();");
    expect((READ.match(/\.from\(bookings\)/g) ?? []).length).toBe(1);
  });

  test("the calendar resolves it ONCE, before the loop, from the range's own rows — no per-row query", () => {
    expect(CAL).toContain("const lastByCourse = await lastLessonDatesForCourses(bookingRows.map((b) => b.courseId)");
    expect(CAL).toContain("courseLast: isCourseLast(row, lastByCourse)");
    // TASK-368 §5.1 added the cancelled TRAY read after this loop, so the region ends at the loop’s own close.
    const loop = region(CAL, "for (const row of bookingRows) {", "\n  }\n");
    expect(loop).not.toContain("await");
  });

  test("the single-booking read agrees with the calendar — same helper, same rule", () => {
    expect(ONE).toContain("lastLessonDatesForCourses(row?.courseId ? [row.courseId] : [], exec)");
    expect(ONE).toContain("courseLast: row ? isCourseLast(row, lastByCourse) : false");
  });

  test("`deriveLiveEndDate` is untouched AT THE SOURCE, `isCourseLast` calls no other 'last' rule, and `bookings` has no `course_last` column", () => {
    // 🔴 TASK-645 — byte-for-byte: the shared function the plan's end and course history read is the one thing this task may not move.
    expect(code(src("src/lib/course-plan.ts"))).toContain("export function deriveLiveEndDate(sessions: Array<{ status: string; date: string }>): string | null {\n  const live = sessions.filter((s) => COURSE_LIVE.has(s.status)).map((s) => s.date);\n  return live.length ? live.reduce((m, d) => (d > m ? d : m)) : null;\n}");
    const PLAN = code(src("src/lib/course-plan.ts"));
    const GROUP = region(PLAN, "export function lastLessonDateByCourse(", "export function isCourseLast(");
    expect(GROUP).toContain("deriveLastLessonDate(sessions)");
    expect(GROUP).not.toContain("deriveLiveEndDate("); // 🚫 the badge's grouping never reaches the shared rule again
    expect(GROUP).not.toMatch(/reduce|Math\.max|sort\(/);
    expect(src("src/db/schema.ts")).not.toMatch(/course_last|courseLast/);
  });
});
