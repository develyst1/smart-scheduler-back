// TASK-392 (`REQ-093`, shape (a)) — ARCHIVE a student: migration `0039` (40 = 40, the `students` lock and the
// cutover order named), `archived_at/by`, archive/unarchive under ONE key, the live-future-sessions 409 with the
// count, the ENUMERATED working reads hidden (each by name), the history reads untouched, the create guard at
// three sites, nothing else touched (by absence). The services are spied at the ROOT app; the rules by source.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ACTION_REGISTRY, isActionKey } from "./permissions";
import { ROUTE_ACCESS } from "./route-access";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { ApiException } from "./http";
import * as v from "../validation";
import * as parentSvc from "../services/parent.service";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const PARENT = code(src("src/services/parent.service.ts"));
const SCHED = code(src("src/services/scheduler.service.ts"));

describe("🔴 the migration — 0039, counted, witnessed, the `students` lock + the cutover order named (source)", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const JOURNAL = readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8");
  const SQL = readFileSync(resolve(root, "drizzle/0039_student_archive.sql"), "utf8").replace(/\r\n/g, "\n");
  const body = SQL.replace(/^--.*$/gm, "");
  test("41 = 41 (TASK-394 added 0040): `0039_student_archive` is the 40th file, idx 39", () => {
    expect(files.length).toBe(41);
    expect(files[39]).toBe("0039_student_archive.sql");
    const j = JSON.parse(JOURNAL) as { entries: Array<{ idx: number; tag: string }> };
    expect(j.entries.length).toBe(41);
    expect(j.entries[39]).toMatchObject({ idx: 39, tag: "0039_student_archive" });
    expect(j.entries[38]).toMatchObject({ idx: 38, tag: "0038_course_rental_marker" }); // the order the one run applies
  });
  test("two nullable column adds on `students`: `archived_at` then `archived_by`; both IF NOT EXISTS; no DEFAULT / NOT NULL; nothing else", () => {
    expect((SQL.match(/--> statement-breakpoint/g) ?? []).length).toBe(1);
    const a = body.indexOf('ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz NULL;');
    const b = body.indexOf('ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "archived_by" text NULL;');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect((body.match(/ALTER TABLE|CREATE /g) ?? []).length).toBe(2);
    expect(body).not.toMatch(/DEFAULT|NOT NULL/);
  });
  test("BOTH headers name the cutover order 0038 → 0039, one run, verify 40; this one names the `students` lock (ACCESS EXCLUSIVE per statement, catalog-only, hundreds of rows) and the queueing blink", () => {
    expect(SQL).toContain("THE CUTOVER ORDER: `0038_course_rental_marker` (TASK-390) then THIS — two files, ONE `db:migrate` run");
    expect(SQL).toContain("`db:verify` expects 40");
    const PREV = readFileSync(resolve(root, "drizzle/0038_course_rental_marker.sql"), "utf8").replace(/\r\n/g, "\n");
    expect(PREV).toContain("THE CUTOVER ORDER: this, then `0039_student_archive` (TASK-392)");
    expect(PREV).toContain("`db:verify` expects 40");
    expect(SQL).toContain("takes **ACCESS EXCLUSIVE on `students`** for the duration of its\n--     statement");
    expect(SQL).toContain("no table\n--     rewrite, no backfill");
    expect(SQL).toContain("`students` is hundreds of rows");
    expect(SQL).toContain("a read-blocking blink");
    expect(SQL).toContain("ONE run, ONE transaction, two statements");
    expect(SQL).toContain("`drizzle/*.sql` = 39 (0000–0038) and journal tags = 39 before this, newest `0038`, so this is `0039`");
  });
  test("🔑 the witness is the LAST column, `archived_by`, registered last; the schema mirrors both", () => {
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0039_student_archive")!; // 🔻 TASK-394: no longer last — by tag
    expect(w).toMatchObject({ tag: "0039_student_archive", probe: { kind: "column", table: "students", column: "archived_by" }, rerunnable: true });
    const S = code(src("src/db/schema.ts"));
    expect(S).toContain('archivedAt: timestamp("archived_at", { withTimezone: true }),');
    expect(S).toContain('archivedBy: text("archived_by"),');
  });
});

describe("🔴 archive / unarchive — the rules by source; nothing else touched (by absence)", () => {
  const A = region(PARENT, "export async function archiveStudent(", "\n}\n");
  const U = region(PARENT, "export async function unarchiveStudent(", "\n}\n");
  test("`archiveStudent`: 404 · idempotent · LIVE future sessions ⇒ 409 with the count (today included, course-live statuses, any type) · writes archived_at/by", () => {
    expect(A).toContain('if (!row) throw notFound("ไม่พบนักเรียน");');
    expect(A).toContain("if (row.archivedAt) return row;");
    expect(A).toContain("const { date: today } = bangkokNow();");
    expect(A).toContain("eq(bookings.studentId, id), sql`${bookings.date} >= ${today}`, inArray(bookings.status, [...COURSE_LIVE_STATUSES])");
    expect(A).toContain('if (n > 0) throw conflict("STUDENT_HAS_LIVE_SESSIONS", `มีคาบเรียนข้างหน้า ${n} คาบ — ยกเลิก/ย้ายก่อน`);');
    expect(A).toContain("db.update(students).set({ archivedAt: new Date(), archivedBy: actor })");
    expect(A.indexOf("STUDENT_HAS_LIVE_SESSIONS")).toBeLessThan(A.indexOf("db.update(students)"));
    expect(A).not.toMatch(/bookingType/); // any type — no filter on it
  });
  test("🚫 archiving touches NOTHING else — no write to bookings / courses / vouchers / rentals / ledger / LINE links / parents", () => {
    for (const F of [A, U]) {
      expect(F).not.toMatch(/\.(update|delete|insert)\((bookings|coursePackages|vouchers|bookingRentals|boMovement|familyLineLinks|parents)\)/);
      expect(F).not.toMatch(/recordSale|recordRental|enqueueLine|clearFamilyLine/);
      expect((F.match(/db\.update\(/g) ?? []).length).toBe(1);
      expect(F).toContain("db.update(students)");
    }
  });
  test("`unarchiveStudent`: 404 · idempotent · the 5-per-parent cap RE-ASKED (a walk-in with no parent skips it) · clears both columns", () => {
    expect(U).toContain('if (!row) throw notFound("ไม่พบนักเรียน");');
    expect(U).toContain("if (!row.archivedAt) return row;");
    expect(U).toContain("if (row.parentId) await assertCanAddStudent(row.parentId);");
    expect(U).toContain("db.update(students).set({ archivedAt: null, archivedBy: null })");
    expect(U.indexOf("assertCanAddStudent(")).toBeLessThan(U.indexOf("db.update(students)"));
  });
  test("the cap counts ACTIVE children only — `assertCanAddStudent` reads through the default (archived-hidden) `listStudentsOfParent`", () => {
    const C = region(PARENT, "export async function assertCanAddStudent(", "\n}\n");
    expect(C).toContain("const current = await listStudentsOfParent(parentId, exec);");
    expect(C).not.toContain("includeArchived");
  });
});

describe("🔴 the WORKING reads — hidden, each by name (the enumeration IS the list)", () => {
  test("1 · `searchStudents` (`GET /students`): `isNull(archived_at)` by default; `archived = true` ⇒ ONLY the archived (the restore view) with `archivedAt` on the rows", () => {
    const S = region(PARENT, "export async function searchStudents(", "\n}\n");
    expect(S).toContain("archived ? isNotNull(students.archivedAt) : isNull(students.archivedAt),");
    expect(S).toContain("archivedAt: students.archivedAt,");
    expect(S).toContain("archivedAt: r.archivedAt ? new Date(r.archivedAt).toISOString() : null,");
    expect(v.studentsQuery.parse({}).archived).toBe(false);
    expect(v.studentsQuery.parse({ archived: "true" }).archived).toBe(true);
    expect(v.studentsQuery.safeParse({ archived: "yes" }).success).toBe(false);
    expect(code(src("src/routes/api.ts"))).toContain("return c.json(await parent.searchStudents(q, limit, archived));");
  });
  test("2 · `getEligibleStudents` (`GET /students/eligible`): the archived id set excluded on BOTH branches, beside the suspended one", () => {
    const E = region(SCHED, "export async function getEligibleStudents(", "\n}\n");
    expect(E).toContain("const archived = await archivedStudentIds();");
    expect((E.match(/!archived\.has\((c|v)\.student\.id\)/g) ?? []).length).toBe(2);
    const I = region(PARENT, "export async function archivedStudentIds(", "\n}\n");
    expect(I).toContain("where(isNotNull(students.archivedAt))");
  });
  test("3 · `listStudentsOfParent` — the ONE helper: archived hidden by default; `includeArchived` only where the parent detail splits ONE read into `students` + `archivedStudents`", () => {
    const L = region(PARENT, "export async function listStudentsOfParent(", "\n}\n");
    expect(L).toContain("opts.includeArchived ? eq(students.parentId, parentId) : and(eq(students.parentId, parentId), isNull(students.archivedAt))");
    // the default callers: the cap, the LIFF register, the webhook's kid lists, the check-in service — none pass the flag
    for (const f of ["src/services/line-register.service.ts", "src/services/line-webhook.service.ts"]) {
      const S = code(src(f));
      expect((S.match(/listStudentsOfParent\(/g) ?? []).length).toBeGreaterThan(0);
      expect(S).not.toContain("includeArchived");
    }
    // the two split sites (the detail + the list): one read each, split by `archivedAt`
    expect((PARENT.match(/\{ includeArchived: true \}/g) ?? []).length).toBe(2);
    expect((PARENT.match(/students: all\.filter\(\(s\) => !s\.archivedAt\), archivedStudents: all\.filter\(\(s\) => !!s\.archivedAt\)/g) ?? []).length).toBe(2);
  });
  test("4 · the attention row (`incomplete_students`): an archived child does not nag", () => {
    expect(code(src("src/services/attention.service.ts"))).toContain("const students = (await db.query.students.findMany()).filter((s) => !s.archivedAt);");
  });
  test("5 · the check-in service's `linkedStudentIds`: an archived child is not offered", () => {
    expect(code(src("src/services/checkin.service.ts"))).toContain("a(e(s.parentId, parent.id), n(s.archivedAt))");
  });
  test("6 · the calendar needs nothing: rosters read students THROUGH bookings, and an archived child has no live future row (the 409 is the guard) — pinned as the statement it is", () => {
    // no `archivedAt` filter in the calendar path — deliberately; the refusal is what keeps the grid honest
    const CAL = region(SCHED, "export async function getCalendar(", "\n}\n");
    expect(CAL).not.toContain("archivedAt");
  });
});

describe("🚫 the HISTORY / by-id reads — untouched (an archived child's past still reads)", () => {
  test("`/bookings?q=`'s `studentSearchQuery`, the parents search by child name, `suspendedStudentIds`, the SOM count, `course-deduction`, `line-admin` — no `archivedAt` in any of them", () => {
    expect(code(src("src/services/search.queries.ts"))).not.toContain("archivedAt");
    expect(region(PARENT, "export async function listParents(", "const withKids")).not.toContain("archivedAt"); // the SEARCH half — the kids split below it is the parent detail's rule
    expect(region(PARENT, "export async function suspendedStudentIds(", "\n}\n")).not.toContain("archivedAt");
    expect(code(src("src/services/som-report.service.ts"))).not.toContain("archivedAt");
    expect(code(src("src/lib/course-deduction.ts"))).not.toContain("archivedAt");
    expect(code(src("src/lib/line-admin.ts"))).not.toContain("archivedAt");
    // the history-free DELETE (TASK-364) is untouched
    expect(region(PARENT, "export async function deleteStudent(", "\n}\n")).not.toContain("archivedAt");
  });
});

describe("🔴 the create guard — ONE helper, THREE sites (bookings · courses · vouchers), pinned by count", () => {
  test("`assertStudentActive` ⇒ 409 STUDENT_ARCHIVED with the sentence; called right after `resolveStudentId` in the three creates and nowhere else", () => {
    const G = region(PARENT, "export async function assertStudentActive(", "\n}\n");
    expect(G).toContain('if (row?.archivedAt) throw conflict("STUDENT_ARCHIVED", "นักเรียนถูกเก็บแล้ว — คืนสถานะก่อน");');
    expect((SCHED.match(/await assertStudentActive\(tx, studentId\);/g) ?? []).length).toBe(3);
    for (const fn of ["export async function createBooking(", "export async function createCoursePackage(", "export async function createVoucher("]) {
      const F = region(SCHED, fn, "\n}\n");
      expect(F).toContain("assertStudentActive(tx, studentId)");
      expect(F.indexOf("resolveStudentId(tx, input.student)")).toBeLessThan(F.indexOf("assertStudentActive(tx, studentId)"));
    }
    // the imports (courses/vouchers) and the per-session edits are NOT guarded — an import is history, an edit is not a new student
    for (const fn of ["export async function importCoursePackage(", "export async function importVoucher("]) expect(region(SCHED, fn, "\n}\n")).not.toContain("assertStudentActive");
  });
});

describe("🔑 the routes through the ROOT app (service spied) + the key", () => {
  const spies: any[] = [];
  afterAll(() => spies.forEach((s) => s.mockRestore()));
  afterEach(() => { process.env.SKIP_AUTH = "true"; });
  const post = (path: string) => rootApp.fetch(new Request(`http://localhost${path}`, { method: "POST" }));
  const ROW = { id: "s-1", name: "น้องเอ", nickname: "เอ", parentId: "p-1", archivedAt: "2026-09-18T01:00:00.000Z", archivedBy: "dev" };

  test("POST /students/:id/archive ⇒ { student } with the actor; the live-sessions 409 envelope by value with the count", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(parentSvc, "archiveStudent").mockImplementation((async (id: string, actor: any) => {
      calls.push([id, actor]);
      if (id === "s-live") throw new ApiException(409, "STUDENT_HAS_LIVE_SESSIONS", "มีคาบเรียนข้างหน้า 3 คาบ — ยกเลิก/ย้ายก่อน");
      return { ...ROW, id };
    }) as any);
    spies.push(s);
    const ok = await post("/api/students/s-1/archive");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).student).toMatchObject({ id: "s-1", archivedAt: "2026-09-18T01:00:00.000Z", archivedBy: "dev" });
    expect(calls.at(-1)).toEqual(["s-1", "dev"]);
    const live = await post("/api/students/s-live/archive");
    expect(live.status).toBe(409);
    expect(await live.json()).toEqual({ error: { code: "STUDENT_HAS_LIVE_SESSIONS", message: "มีคาบเรียนข้างหน้า 3 คาบ — ยกเลิก/ย้ายก่อน" } });
  });
  test("POST /students/:id/unarchive ⇒ { student } restored; the family-cap 400 passes through", async () => {
    process.env.SKIP_AUTH = "true";
    const s = spyOn(parentSvc, "unarchiveStudent").mockImplementation((async (id: string) => {
      if (id === "s-full") throw new ApiException(400, "VALIDATION", "เพิ่มนักเรียนได้สูงสุด 5 คนต่อเบอร์");
      return { ...ROW, id, archivedAt: null, archivedBy: null };
    }) as any);
    spies.push(s);
    const ok = await post("/api/students/s-1/unarchive");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).student).toMatchObject({ id: "s-1", archivedAt: null, archivedBy: null });
    expect((await post("/api/students/s-full/unarchive")).status).toBe(400);
  });
  test("GET /students?archived=true reaches `searchStudents(q, limit, true)`; the default `false`", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(parentSvc, "searchStudents").mockImplementation((async (q: any, limit: any, archived: any) => { calls.push([q, limit, archived]); return []; }) as any);
    spies.push(s);
    expect((await rootApp.fetch(new Request("http://localhost/api/students?archived=true&q=a"))).status).toBe(200);
    expect(calls.at(-1)).toEqual(["a", 50, true]);
    expect((await rootApp.fetch(new Request("http://localhost/api/students"))).status).toBe(200);
    expect(calls.at(-1)).toEqual([undefined, 50, false]);
  });
  test("ONE key for both directions: `action:people.student-archive` (48th) with its labels; both routes under PEOPLE; the delete keeps its own key", () => {
    expect(isActionKey("action:people.student-archive")).toBe(true);
    expect(ACTION_REGISTRY.find((a) => a.key === "action:people.student-archive")).toEqual({ key: "action:people.student-archive", area: "people", labelTh: "เก็บ/คืนสถานะนักเรียน", labelEn: "Archive & restore a student" });
    expect(ROUTE_ACCESS["POST /students/:id/archive"]).toEqual({ menus: ["menu:people"], action: "action:people.student-archive" });
    expect(ROUTE_ACCESS["POST /students/:id/unarchive"]).toEqual({ menus: ["menu:people"], action: "action:people.student-archive" });
    expect(ROUTE_ACCESS["DELETE /students/:id"]!.action).toBe("action:people.student-delete");
  });
});
