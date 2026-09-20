// TASK-376 (`REQ-091` Deploy B defect, @Tanya on `sid`) — a post-creation SICK LEAVE's make-up must inherit the
// course rental. There were TWO writers of a make-up row and the copy lived in one: the reconcile had it, the
// sick-leave branch of `updateBookingStatus` did not. The fix is ONE `inheritCourseRental(tx, courseId, id)`
// called by BOTH — pinned here by the function's shape, both call sites, the count, and the branches that must
// NOT copy (a locked leave appends nothing).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

describe("🔑 the ONE copy — `inheritCourseRental`", () => {
  const RS = () => code(src("src/services/rental.service.ts"));
  const FN = () => region(RS(), "export async function inheritCourseRental(", "export async function payBookingRental(");

  test("reads the COURSE's rental from any OTHER row of the course (the new row excluded), inserts the inherited stamps, no post; no-op when unrented", () => {
    const F = FN();
    expect(F).toContain(".from(bookingRentals)\n    .innerJoin(bookings, eq(bookings.id, bookingRentals.bookingId))");
    expect(F).toContain(".where(and(eq(bookings.courseId, courseId), ne(bookings.id, newBookingId)))");
    expect(F).toContain(".limit(1);");
    expect(F).toContain("if (!source) return null;");
    expect(F).toContain("paidAt: bookingRentals.paidAt, paidActor: bookingRentals.paidActor, createdBy: bookingRentals.createdBy");
    expect(F).toContain(".insert(bookingRentals).values({ bookingId: newBookingId, ...source })");
    expect(F).not.toMatch(/recordRental|recordSale|new Date\(\)/); // inherited stamps, never re-stamped, never posted
  });
});

describe("🔴 BOTH make-up writers call it — and nothing else copies (source)", () => {
  const SVC = () => code(src("src/services/scheduler.service.ts"));
  const RECONCILE = () => region(SVC(), "export async function reconcileCoursePlan(", "\n}\n");
  const SICK = () => region(SVC(), '} else if (action === "sick-leave"', "for (const sid of duoStudentIds(current)) await awardCrmPoints(sid, CRM_POINT_RULES.PROPER_SICK_LEAVE, tx);");

  test("writer 1 — the reconcile: after each appended row's insert", () => {
    const R = RECONCILE();
    expect(R).toContain("await inheritCourseRental(tx, courseId, ext.id);");
    expect(R.indexOf("inheritCourseRental(")).toBeGreaterThan(R.indexOf(".insert(bookings)"));
  });

  test("🔴 writer 2 — the sick-leave append (the one that shipped without it): after ITS insert, inside the within-quota branch", () => {
    const S = SICK();
    expect(S).toContain('note: "คาบขยายอัตโนมัติจากการลา"');
    expect(S).toContain("await inheritCourseRental(tx, current.courseId, ext.id);");
    expect(S.indexOf("inheritCourseRental(")).toBeGreaterThan(S.indexOf("extendedId = ext.id;"));
    expect(S.indexOf("inheritCourseRental(")).toBeLessThan(S.indexOf("locked = true;"));
  });

  test("a LOCKED (over-quota) leave appends nothing — and therefore copies nothing", () => {
    const S = SICK();
    const locked = S.slice(S.indexOf("} else {\n          locked = true;"));
    expect(locked).not.toMatch(/insert\(bookings\)|inheritCourseRental/);
  });

  test("🔑 exactly TWO call sites in the scheduler, and no other `insert(bookingRentals)` on a make-up anywhere", () => {
    const s = SVC();
    expect((s.match(/inheritCourseRental\(/g) ?? []).length).toBe(2);
    // the only remaining rental inserts in the scheduler are the CREATE pass (the rows a course is born with)
    expect((s.match(/insert\(bookingRentals\)/g) ?? []).length).toBe(1);
    expect(region(s, "export async function createCoursePackage(", "\n}\n")).toContain("insert(bookingRentals)");
    // …and in rental.service: the session `record` and the chokepoint itself — nothing else
    const rs = code(src("src/services/rental.service.ts"));
    expect((rs.match(/insert\(bookingRentals\)/g) ?? []).length).toBe(2);
    expect((rs.match(/inheritCourseRental\(/g) ?? []).length).toBe(1); // the definition
  });

  test("📌 the THIRD writer of live rows — `resumeCourse` via `insertBooking` — is named, not wired (the owner has not asked)", () => {
    const RESUME = region(SVC(), "export async function resumeCourse(", "\n}\n");
    expect(RESUME).toContain("await insertBooking(tx, studentId, {");
    expect(RESUME).not.toContain("inheritCourseRental");
  });
});
