// TASK-390 (`REQ-091 §14`, rental round 2) — (1) the `Rental :` line in `course_confirmed`, both audiences, last;
// (2) the pay-per-session variant (`paidUpfront: false` ⇒ rows born UNPAID, no post at creation, stored on the
// course); (3) `DELETE /courses/:id/rental` — the marker + the future live rows' rental rows deleted, NO money, and
// `inheritCourseRental` honouring the marker in its one query. Migration `0038` counted, witnessed, the lock named.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { courseRentalSummary, rentalPrintLine } from "./rental-row";
import { toCourseWithStudent } from "../db/mappers";
import { ACTION_REGISTRY, isActionKey } from "./permissions";
import { ROUTE_ACCESS } from "./route-access";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { ApiException } from "./http";
import * as v from "../validation";
import * as rentalSvc from "../services/rental.service";
import { readSrc } from "./read-src";
import { uuidFor } from "./test-uuid";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a);
  return s.slice(a, b < 0 ? undefined : b);
};
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };

const COURSE = {
  kind: "course_confirmed", courseId: "c1", studentName: "น้องเอ", subject: "Private Freeskate", bookingType: "COURSE_PACKAGE",
  size: 6, expiryDate: "2026-12-31", coach: "ครูหนึ่ง", startDate: "2026-09-06", weekday: 0, startTime: "10:00", endTime: "11:00",
  plannedLeaveDates: ["2026-09-14"], note: "แพ้ถั่ว",
} as any;
const LINE = rentalPrintLine("rental-set", "inline skate size 18-19 CM");

describe("🔴 (1) the confirm line — both audiences, LAST, `*ถ้ามี`; unrented byte-identical", () => {
  test("rented ⇒ `Rental : <line>` is the LAST line for the parent AND the teacher, in both languages", () => {
    for (const audience of ["parent", "teacher"] as const) {
      for (const lang of ["TH", "EN"] as const) {
        const msg = formatOutboxMessage({ ...COURSE, rental: LINE }, {}, lang, audience);
        const lines = msg.split("\n");
        expect({ audience, lang, last: lines.at(-1) }).toEqual({ audience, lang, last: `Rental : ${LINE}` });
        expect(lines.at(-2)).toBe("Remark : แพ้ถั่ว"); // after `Remark`, as the reminder prints it
      }
    }
  });
  test("unrented (`rental: null` or absent) ⇒ byte-for-byte the message before this task — no empty `Rental :`", () => {
    for (const audience of ["parent", "teacher"] as const) {
      const before = formatOutboxMessage(COURSE, {}, "TH", audience);
      expect(formatOutboxMessage({ ...COURSE, rental: null }, {}, "TH", audience)).toBe(before);
      expect(before).not.toContain("Rental");
      expect(before.split("\n").at(-1)).toBe("Remark : แพ้ถั่ว");
    }
  });
  test("the parent and the teacher differ ONLY in the audience-omitted block lines — the rental line is shared (one payload, one renderer)", () => {
    const p = formatOutboxMessage({ ...COURSE, rental: LINE }, {}, "TH", "parent").split("\n");
    const t = formatOutboxMessage({ ...COURSE, rental: LINE }, {}, "TH", "teacher").split("\n");
    expect(p.filter((l) => l.startsWith("Rental"))).toEqual(t.filter((l) => l.startsWith("Rental")));
  });
  test("the payload carries the RENDERED line, built once in `confirmCourse` from the rows' rental (the marker wins); the rows are loaded with their rental (source)", () => {
    const SVC = code(src("src/services/scheduler.service.ts"));
    const P = region(SVC, "const coursePayload = {", "const notification = confirmed");
    expect(P).toContain("rental: course.rentalRemovedAt ? null : (() => { const r = courseRentalOf(rows); return r ? rentalPrintLine(r.code, r.remark) : null; })(),");
    expect(region(SVC, "async function loadCourseForEnd(", "\n}\n")).toContain("with: { teacher: true, subject: true, student: true, coStudent: true, rental: true }") // 🔻 TASK-425: + the co-student for the notice's name;
    expect(code(src("src/lib/line-message.ts"))).toContain('extra(t("ob_f_rental", lang), fieldValue(payload.rental))');
  });
});

describe("🔴 (2) the variant — `paidUpfront` default true; false ⇒ rows born unpaid, NO post at creation, stored on the course", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const body = (rental: unknown) => ({ student: { id: T }, teacherId: T, subjectId: T, size: 4, startDate: "2026-09-16", startTime: "10:00", rental });
  test("the shape: `paidUpfront` optional, DEFAULTS to true (today's callers unchanged); false accepted; a non-boolean refused", () => {
    const d = v.createCoursePackage.safeParse(body({ code: "rental-set", remark: "M" }));
    expect(d.success).toBe(true);
    expect((d as any).data.rental.paidUpfront).toBe(true);
    const f = v.createCoursePackage.safeParse(body({ code: "rental-set", remark: "M", paidUpfront: false }));
    expect(f.success).toBe(true);
    expect((f as any).data.rental.paidUpfront).toBe(false);
    expect(v.createCoursePackage.safeParse(body({ code: "rental-set", remark: "M", paidUpfront: "no" })).success).toBe(false);
  });
  test("the create (source): the variant is STORED (`rental_paid_upfront`), `paidAt` is null when not upfront, the paid actor too, and the ONE post runs only when paid upfront", () => {
    const C = region(code(src("src/services/scheduler.service.ts")), "export async function createCoursePackage(", "\n}\n");
    expect(C).toContain("const paidUpfront = input.rental.paidUpfront !== false;");
    expect(C).toContain("await tx.update(coursePackages).set({ rentalPaidUpfront: paidUpfront }).where(eq(coursePackages.id, course.id));");
    expect(C).toContain("const paidAt = paidUpfront ? new Date() : null;");
    expect(C).toContain("paidActor: paidUpfront ? (input.actor ?? null) : null,");
    expect(C).toContain("if (input.rental && input.rental.paidUpfront !== false) {\n    void recordRental({");
    expect((C.match(/recordRental\(/g) ?? []).length).toBe(1); // still ONE post site
  });
  test("`courseRentalSummary` by value: `unpaidSessions` counts COURSE-LIVE rows (PENDING · CONFIRMED · EXTENDED) without `paidAt` — a pay-per-session course counts down; a paid-upfront one is 0; leave / cancelled / attended rows never count", () => {
    const row = (status: string, paidAt: Date | null) => ({ status, rental: { code: "rental-set", remark: "M", paidAt } });
    expect(courseRentalSummary([row("CONFIRMED", null), row("EXTENDED", null), row("PENDING", new Date()), row("SICK_LEAVE", null), row("CANCELLED", null), row("ATTENDED", null)])).toEqual({ code: "rental-set", remark: "M", unpaidSessions: 2 });
    expect(courseRentalSummary([row("CONFIRMED", new Date()), row("CONFIRMED", new Date())])).toEqual({ code: "rental-set", remark: "M", unpaidSessions: 0 });
    expect(courseRentalSummary([{ status: "CONFIRMED", rental: null }])).toBeNull();
  });
  test("the course DTO: `paidUpfront` from the STORED column (pre-0038 rented ⇒ true), `unpaidSessions` from the rows; the MARKER ⇒ `rental: null` even with rows", () => {
    const base = { id: "c", size: 4, usedSessions: 0, expiryDate: "2026-12-01", startDate: "2026-09-16", weekday: 3, startTime: "10:00", status: "CONFIRMED", student: { id: "s", name: "S" } };
    const rows = [{ status: "CONFIRMED", rental: { code: "rental-set", remark: "M", paidAt: null } }, { status: "CONFIRMED", rental: { code: "rental-set", remark: "M", paidAt: new Date() } }];
    expect(toCourseWithStudent({ ...base, rentalPaidUpfront: false, bookings: rows }).rental).toEqual({ code: "rental-set", remark: "M", paidUpfront: false, unpaidSessions: 1 });
    expect(toCourseWithStudent({ ...base, rentalPaidUpfront: null, courseRental: { code: "rental-set", remark: "M", unpaidSessions: 0 } }).rental).toEqual({ code: "rental-set", remark: "M", paidUpfront: true, unpaidSessions: 0 });
    // 🔴 the trap the column exists for (mutation K passed without this): a pay-per-session course that has been paid up so
    // far has 0 unpaid — and is STILL pay-per-session. Derived from the rows it would read "upfront"; stored, it does not.
    expect(toCourseWithStudent({ ...base, rentalPaidUpfront: false, courseRental: { code: "rental-set", remark: "M", unpaidSessions: 0 } }).rental).toEqual({ code: "rental-set", remark: "M", paidUpfront: false, unpaidSessions: 0 });
    expect(toCourseWithStudent({ ...base, rentalPaidUpfront: true, rentalRemovedAt: new Date(), bookings: rows }).rental).toBeNull();
    expect(toCourseWithStudent({ ...base, rentalRemovedAt: new Date(), courseRental: { code: "rental-set", remark: "M", unpaidSessions: 0 } }).rental).toBeNull();
  });
  test("a make-up inherits the UNPAID state: `inheritCourseRental` copies `paidAt`/`paidActor` from its source and stamps nothing new (source)", () => {
    const F = region(code(src("src/services/rental.service.ts")), "export async function inheritCourseRental(", "\n}\n");
    expect(F).toContain("paidAt: bookingRentals.paidAt, paidActor: bookingRentals.paidActor");
    expect(F).toContain(".values({ bookingId: newBookingId, ...source })");
    expect(F).not.toMatch(/new Date\(\)|recordRental|recordSale/);
  });
});

describe("🔴 (3) remove from the remaining sessions — the marker, future LIVE rows only, NO money; the marker honoured by the one copy", () => {
  const RS = code(src("src/services/rental.service.ts"));
  const D = region(RS, "export async function removeCourseRental(", "\n}\n");
  test("the service (source): 404 unknown · 409 RENTAL_NOT_ON_COURSE when marked or no rows · ONE tx: the marker, then delete rental rows of `date >= today` (Bangkok) ∧ live status · `{ removed: n }`", () => {
    expect(D).toContain('if (!course) throw notFound("ไม่พบคอร์ส");');
    expect(D).toContain('if (course.rentalRemovedAt) throw conflict("RENTAL_NOT_ON_COURSE", "คอร์สนี้ไม่มีค่าเช่าอุปกรณ์");');
    expect(D).toContain('if (!any) throw conflict("RENTAL_NOT_ON_COURSE", "คอร์สนี้ไม่มีค่าเช่าอุปกรณ์");');
    expect(D).toContain("const today = bangkokNow().date;");
    expect(D).toContain("await tx.update(coursePackages).set({ rentalRemovedAt: new Date() }).where(eq(coursePackages.id, courseId));");
    expect(D).toContain("gte(bookings.date, today), inArray(bookings.status, [...COURSE_LIVE_STATUSES])");
    expect(D).toContain("tx.delete(bookingRentals).where(inArray(bookingRentals.bookingId, ids))");
    expect(D.indexOf("rentalRemovedAt: new Date()")).toBeLessThan(D.indexOf("tx.delete(bookingRentals)"));
    expect(D).toContain("return { removed };");
  });
  test("🚫 NO MONEY MOVES — asserted by absence: no `recordRental`, `recordSale`, `boMovement`, `refund` in the remover; it never touches `paid_at` of a past row (it deletes FUTURE rows, updates none)", () => {
    expect(D).not.toMatch(/recordRental|recordSale|boMovement|refund|postBookingSale/);
    expect(D).not.toMatch(/tx\.update\(bookingRentals\)|\.set\(\{ paidAt/);
    expect((D.match(/tx\.delete\(/g) ?? []).length).toBe(1);
  });
  test("🔴 the marker in the ONE copy: `inheritCourseRental`'s source query joins `course_packages` with `isNull(rentalRemovedAt)` — both writers (reconcile + sick-leave append) covered, signature unchanged", () => {
    const F = region(RS, "export async function inheritCourseRental(", "\n}\n");
    expect(F).toContain(".innerJoin(coursePackages, and(eq(coursePackages.id, bookings.courseId), isNull(coursePackages.rentalRemovedAt)))");
    expect(F).toContain("export async function inheritCourseRental(tx: any, courseId: string, newBookingId: string)");
    const SVC = code(src("src/services/scheduler.service.ts"));
    expect((SVC.match(/await inheritCourseRental\(tx, /g) ?? []).length).toBe(2); // TASK-376's two call sites, untouched
  });
  test("the route through the ROOT app: `DELETE /api/courses/:id/rental` ⇒ `{ removed: n }` with the actor; the 409 envelope by value", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(rentalSvc, "removeCourseRental").mockImplementation((async (id: string, actor: any) => {
      calls.push([id, actor]);
      if (id === uuidFor("c-none")) throw new ApiException(409, "RENTAL_NOT_ON_COURSE", "คอร์สนี้ไม่มีค่าเช่าอุปกรณ์");
      return { removed: 3 };
    }) as any);
    try {
      const ok = await rootApp.fetch(new Request(`http://localhost/api/courses/${uuidFor("c-1")}/rental`, { method: "DELETE" }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ removed: 3 });
      expect(calls.at(-1)).toEqual([uuidFor("c-1"), "dev"]);
      const none = await rootApp.fetch(new Request(`http://localhost/api/courses/${uuidFor("c-none")}/rental`, { method: "DELETE" }));
      expect(none.status).toBe(409);
      expect(await none.json()).toEqual({ error: { code: "RENTAL_NOT_ON_COURSE", message: "คอร์สนี้ไม่มีค่าเช่าอุปกรณ์" } });
    } finally { s.mockRestore(); }
  });
  test("the key: `action:bookings.course-rental` (47th) with its labels, gating exactly this route; the SET stays under `course-create`", () => {
    expect(isActionKey("action:bookings.course-rental")).toBe(true);
    expect(ACTION_REGISTRY.find((a) => a.key === "action:bookings.course-rental")).toEqual({ key: "action:bookings.course-rental", area: "bookings", labelTh: "ถอดค่าเช่าอุปกรณ์ออกจากคอร์ส", labelEn: "Remove a course's rental" });
    expect(ROUTE_ACCESS["DELETE /courses/:id/rental"]).toEqual({ menus: ["menu:bookings"], action: "action:bookings.course-rental" });
    expect(Object.entries(ROUTE_ACCESS).filter(([, a]) => a.action === "action:bookings.course-rental").map(([k]) => k)).toEqual(["DELETE /courses/:id/rental"]);
    expect(ROUTE_ACCESS["POST /courses"]!.action).toBe("action:bookings.course-create");
  });
});

describe("🔴 the migration — 0038, counted, witnessed, the `course_packages` lock named (source)", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const JOURNAL = readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8");
  const SQL = readFileSync(resolve(root, "drizzle/0038_course_rental_marker.sql"), "utf8").replace(/\r\n/g, "\n");
  const body = SQL.replace(/^--.*$/gm, "");
  test("55 = 55 (0039 … 0054 added since): `0038_course_rental_marker` is the 39th file, idx 38", () => {
    expect(files.length).toBe(55);
    expect(files[38]).toBe("0038_course_rental_marker.sql");
    const j = JSON.parse(JOURNAL) as { entries: Array<{ idx: number; tag: string }> };
    expect(j.entries.length).toBe(55);
    expect(j.entries[38]).toMatchObject({ idx: 38, tag: "0038_course_rental_marker" });
  });
  test("two nullable column adds on `course_packages`, the marker then the variant, both IF NOT EXISTS, nothing else", () => {
    expect((SQL.match(/--> statement-breakpoint/g) ?? []).length).toBe(1);
    const a = body.indexOf('ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "rental_removed_at" timestamptz NULL;');
    const b = body.indexOf('ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "rental_paid_upfront" boolean NULL;');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect((body.match(/ALTER TABLE|CREATE /g) ?? []).length).toBe(2);
    expect(body).not.toMatch(/DEFAULT|NOT NULL/);
  });
  test("the header names the lock (ACCESS EXCLUSIVE on `course_packages` per statement, catalog-only, hundreds–low thousands of rows), the queueing blink, one run", () => {
    expect(SQL).toContain("takes **ACCESS EXCLUSIVE on `course_packages`** for the\n--     duration of its statement");
    expect(SQL).toContain("no table rewrite, no backfill");
    expect(SQL).toContain("hundreds to low\n--     thousands of rows");
    expect(SQL).toContain("a read-blocking blink");
    expect(SQL).toContain("ONE run, ONE transaction, two statements");
    expect(SQL).toContain("`drizzle/*.sql` = 38 (0000–0037) and journal tags = 38 before this, newest `0037`, so this is `0038`");
  });
  test("🔑 the witness is the LAST column, `rental_paid_upfront`, registered; the schema mirrors both columns", () => {
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0038_course_rental_marker")!; // 🔻 TASK-392: no longer last — by tag
    expect(w).toMatchObject({ tag: "0038_course_rental_marker", probe: { kind: "column", table: "course_packages", column: "rental_paid_upfront" }, rerunnable: true });
    const S = code(src("src/db/schema.ts"));
    expect(S).toContain('rentalRemovedAt: timestamp("rental_removed_at", { withTimezone: true }),');
    expect(S).toContain('rentalPaidUpfront: boolean("rental_paid_upfront"),');
  });
});
