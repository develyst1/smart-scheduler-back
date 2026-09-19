// TASK-373 (`REQ-091 §9`, Deploy B, T3) — whole-course rental at creation: a PAID `booking_rentals` row on every
// LIVE session the course is born with (none on a leave row), ONE post `recordRental({ hours: size, refId:
// courseId })` where the course sale posts, and a later leave's make-up INHERITS a paid row copied from the
// COURSE's rental (derived from its rows — no column, 36 = 36). The DoD counts are pinned by simulating the
// create's row selection with the real pure helpers; the order, the post and the copy are pinned at the source.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { COURSE_LIVE_STATUSES, makeupsToFlip, plannedRowCount } from "./course-plan";
import { courseRentalOf, rentalRemarkRequired } from "./rental-row";
import { toCourseWithStudent } from "../db/mappers";
import { readSrc } from "./read-src";
import * as v from "../validation";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.SKIP_AUTH = "true";

const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return s.slice(a, b);
};
const T = "11111111-1111-4111-8111-111111111111";
const body = (extra: Record<string, unknown> = {}) => ({ student: { id: T }, teacherId: T, subjectId: T, size: 4, startDate: "2026-09-16", startTime: "10:00", ...extra });

/** The create, simulated with the real helpers: chain rows, absences flipped, make-ups appended, then the rental pass. */
const simulateCreate = (size: number, absent: Set<number>, rented: boolean) => {
  const rows: Array<{ id: string; status: string; rental: null | { code: string; remark: string | null; paidAt: Date } }> =
    Array.from({ length: size }, (_, i) => ({ id: `r${i + 1}`, status: absent.has(i + 1) ? "SICK_LEAVE" : "CONFIRMED", rental: null }));
  const reconcile = () => { const live = rows.filter((r) => r.status !== "SICK_LEAVE").length; for (let k = live; k < size; k++) rows.push({ id: `r${rows.length + 1}`, status: "EXTENDED", rental: null }); };
  reconcile();
  const wanted = plannedRowCount(size, absent);
  for (let guard = 0; guard < wanted; guard++) {
    const toFlip = makeupsToFlip(rows, size, absent);
    if (!toFlip.length) break;
    for (const r of toFlip) r.status = "SICK_LEAVE";
    reconcile();
  }
  // the rental pass — AFTER the flip loop, over the FINAL live rows (the create's own `finalRows` query)
  let posts = 0;
  if (rented) {
    const paidAt = new Date();
    for (const r of rows) if ((COURSE_LIVE_STATUSES as readonly string[]).includes(r.status)) r.rental = { code: "rental-set", remark: "ชุด M", paidAt };
    posts = 1;
  }
  return { rows, posts };
};

describe("🔑 the DoD counts — simulated with the real helpers", () => {
  test("size 4 + 1 absence ⇒ 5 rows, 4 PAID rentals: the make-up has one, the leave row has none; ONE post", () => {
    const { rows, posts } = simulateCreate(4, new Set([2]), true);
    expect(rows.length).toBe(5);
    expect(rows.filter((r) => r.rental).length).toBe(4);
    expect(rows.find((r) => r.status === "SICK_LEAVE")!.rental).toBeNull();
    expect(rows.at(-1)!.status).toBe("EXTENDED");
    expect(rows.at(-1)!.rental).toMatchObject({ code: "rental-set", remark: "ชุด M" });
    expect(posts).toBe(1);
  });

  test("size 10, no absence ⇒ 10 paid rows, one post; all-absent size 4 ⇒ 8 rows, 4 paid (the four make-ups)", () => {
    expect(simulateCreate(10, new Set(), true).rows.filter((r) => r.rental).length).toBe(10);
    const all = simulateCreate(4, new Set([1, 2, 3, 4]), true);
    expect(all.rows.length).toBe(8);
    expect(all.rows.filter((r) => r.rental).map((r) => r.id)).toEqual(["r5", "r6", "r7", "r8"]);
  });

  test("no `rental` in the body ⇒ zero rows, zero posts — byte for byte today", () => {
    const { rows, posts } = simulateCreate(4, new Set([2]), false);
    expect(rows.every((r) => r.rental === null)).toBe(true);
    expect(posts).toBe(0);
  });

  test("the COURSE's rental is derived from its rows — any row with one; a leave row first does not hide it; none ⇒ null", () => {
    const { rows } = simulateCreate(4, new Set([1]), true);
    expect(rows[0]!.status).toBe("SICK_LEAVE");
    expect(courseRentalOf(rows)).toEqual({ code: "rental-set", remark: "ชุด M" });
    expect(courseRentalOf(simulateCreate(4, new Set(), false).rows)).toBeNull();
    expect(courseRentalOf([])).toBeNull();
  });

  test("the remark rule is the SAME function (set + ride); the validator accepts the shape and refuses an unknown code", () => {
    expect(rentalRemarkRequired("rental-set", "")).toBe(true);
    expect(v.createCoursePackage.safeParse(body({ rental: { code: "rental-helmet-pads" } })).success).toBe(true);
    expect(v.createCoursePackage.safeParse(body({ rental: { code: "rental-set", remark: "ชุด M" } })).success).toBe(true);
    expect(v.createCoursePackage.safeParse(body({ rental: { code: "rental-boat" } })).success).toBe(false);
    expect(v.createCoursePackage.safeParse(body()).success).toBe(true);
  });

  test("the course DTO carries `rental` — from the grouped read when spread on, else from the loaded rows, else null", () => {
    const course = { id: "c", size: 4, usedSessions: 0, expiryDate: "2026-12-01", startDate: "2026-09-16", weekday: 3, startTime: "10:00", status: "CONFIRMED", student: { id: T, name: "S" } };
    // 🔻 TASK-390: the grouped read spreads a SUMMARY (`unpaidSessions`); the DTO adds `paidUpfront` (stored; pre-0038 ⇒ true).
    expect(toCourseWithStudent({ ...course, courseRental: { code: "rental-ride", remark: "38", unpaidSessions: 0 } }).rental).toEqual({ code: "rental-ride", remark: "38", paidUpfront: true, unpaidSessions: 0 });
    expect(toCourseWithStudent({ ...course, bookings: simulateCreate(4, new Set([1]), true).rows }).rental).toEqual({ code: "rental-set", remark: "ชุด M", paidUpfront: true, unpaidSessions: 0 }); // 🔻 TASK-390: born paid ⇒ 0 to collect
    expect(toCourseWithStudent({ ...course }).rental).toBeNull();
  });
});

describe("🔴 the create — order, the ONE post, no discount, the mirrored gap (source)", () => {
  const SVC = code(src("src/services/scheduler.service.ts"));
  const CREATE = () => region(SVC, "export async function createCoursePackage(", "\n}\n");

  test("the remark rule is refused BEFORE the transaction, beside the discount", () => {
    const C = CREATE();
    expect(C).toContain("if (input.rental && rentalRemarkRequired(input.rental.code, input.rental.remark)) {");
    expect(C.indexOf("rentalRemarkRequired(")).toBeLessThan(C.indexOf("db.transaction("));
  });

  test("🔑 the rental rows are inserted AFTER the flip loop, over the FINAL live rows (COURSE_LIVE_STATUSES), paid + actor stamped", () => {
    const C = CREATE();
    const flipLoop = C.indexOf("const toFlip = makeupsToFlip(");
    const rentalPass = C.indexOf("if (input.rental) {\n      const paidUpfront = input.rental.paidUpfront !== false;"); // 🔻 TASK-390: the variant first
    expect(flipLoop).toBeGreaterThan(-1);
    expect(rentalPass).toBeGreaterThan(flipLoop);
    expect(C).toContain("inA(b.status, [...COURSE_LIVE_STATUSES])");
    expect(C).toContain("await tx.insert(bookingRentals).values({\n          bookingId: r.id,\n          code: input.rental.code,");
    expect(C).toContain("paidAt,\n          paidActor: paidUpfront ? (input.actor ?? null) : null,\n          createdBy: input.actor ?? null,"); // 🔻 TASK-390: paid stamps only when paid upfront
  });

  test("🔑 ONE post, after the transaction, beside the course sale: hours = size, refId = courseId, NO discount, the rejection caught", () => {
    const C = CREATE();
    const post = "void recordRental({ code: input.rental.code, hours: input.size, refId: result.course.id, actor: input.actor ?? null }).catch(";
    expect(C).toContain(post);
    expect((C.match(/recordRental\(/g) ?? []).length).toBe(1);
    expect(C.indexOf(post)).toBeGreaterThan(C.indexOf("void recordSale(courseItemRef(priceGroup, input.size), 1, {"));
    expect(C.indexOf(post)).toBeGreaterThan(C.lastIndexOf("  });\n")); // outside the transaction callback
    const postLine = C.slice(C.indexOf(post), C.indexOf("\n", C.indexOf(post)));
    expect(postLine).not.toContain("discount");
    expect(C).toContain("console.error(`[rental] NOT POSTED — course ${result.course.id}");
  });

  test("the returned course DTO derives its rental from the rows it just loaded", () => {
    expect(CREATE()).toContain("toCourseWithStudent({ ...courseRow, bookings: created })");
  });
});

describe("🔴 the reconcile — a later make-up inherits the COURSE's rental through the ONE copy (source)", () => {
  // 🔻 TASK-376 — this block used to pin an INLINE copy here, and that is exactly how the sick-leave writer's
  // make-up shipped without its R: the copy lived in one of two writers. It now pins the call to the chokepoint;
  // `course-rental-inherit-req091.test.ts` pins both writers, the count, and the function itself.
  const SVC = code(src("src/services/scheduler.service.ts"));
  const REC = () => region(SVC, "export async function reconcileCoursePlan(", "\n}\n");

  test("the copy is the ONE function, called per appended row right after its insert; no inline copy, no pre-read, no post", () => {
    const R = REC();
    expect(R).toContain("await inheritCourseRental(tx, courseId, ext.id);");
    expect(R.indexOf("inheritCourseRental(")).toBeGreaterThan(R.indexOf("appended.push(ext.id);"));
    expect(R.indexOf("inheritCourseRental(")).toBeLessThan(R.indexOf("fromDate = extDate;"));
    expect(R).not.toMatch(/insert\(bookingRentals\)|courseRental|template\.rental|recordRental|recordSale/);
  });
});

describe("🔴 no column, no migration; the list's grouped read; the resume path does not inherit (source)", () => {
  test("43 = 43 (0036 … 0042 added since — none a rental CODE column) — no `rental_code` on course_packages", () => {
    const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBe(43);
    expect(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8").match(/"tag"/g)!.length).toBe(43);
    expect(src("src/db/schema.ts")).not.toMatch(/rental_code|rentalCode|rental_remark/);
  });

  test("the list derives the course rental from ONE grouped read (rows joined to rentals), spread on as `courseRental`", () => {
    const SVC = code(src("src/services/scheduler.service.ts"));
    const G = region(SVC, "async function courseRentalsByCourse(", "async function coursesByIds(");
    expect(G).toContain(".from(bookingRentals)\n    .innerJoin(bookings, eq(bookings.id, bookingRentals.bookingId))\n    .where(inArray(bookings.courseId, courseIds));");
    expect(G).toContain("if (courseIds.length === 0) return new Map();");
    const L = region(SVC, "async function coursesByIds(", "export async function getCourses(");
    expect(L).toContain("const rentalByCourse = await courseRentalsByCourse(ids);");
    expect(L).toContain("toCourseWithStudent({ ...row, courseRental: rentalByCourse.get(id) ?? null })");
  });

  test("📌 the resume path inserts through `insertBooking`, not the reconcile — its new rows carry no rental (said, not built)", () => {
    const SVC = code(src("src/services/scheduler.service.ts"));
    const RESUME = region(SVC, "export async function resumeCourse(", "\n}\n");
    expect(RESUME).toContain("await insertBooking(tx, studentId, {");
    expect(RESUME).not.toMatch(/bookingRentals|courseRental/);
  });
});

const svc = await import("../services/scheduler.service");
const app = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };

describe("🔑 the route — `rental` rides the existing POST /courses body; an unknown code is a 400 at the edge", () => {
  const calls: any[] = [];
  const spy = spyOn(svc, "createCoursePackage").mockImplementation((async (input: any) => { calls.push(input); return { course: { id: "c" }, bookings: [] }; }) as any);
  afterAll(() => spy.mockRestore());
  const post = (b: unknown) => app.fetch(new Request("http://localhost/api/courses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

  test("with `rental` ⇒ the service receives it with the actor; without ⇒ no `rental` key", async () => {
    expect((await post(body({ rental: { code: "rental-helmet", remark: "" } }))).status).toBe(201);
    expect(calls.at(-1)).toMatchObject({ rental: { code: "rental-helmet" }, actor: "dev" });
    expect((await post(body())).status).toBe(201);
    expect("rental" in calls.at(-1)).toBe(false);
  });

  test("an unknown code ⇒ 400, the service never called", async () => {
    const n = calls.length;
    expect((await post(body({ rental: { code: "rental-boat" } }))).status).toBe(400);
    expect(calls.length).toBe(n);
  });
});
