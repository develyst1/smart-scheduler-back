// TASK-420 (`REQ-095 §13`, SPEC-085 B) — DUO = ONE course, TWO kids: migration `0048` (two NULL columns on course_packages,
// one on bookings, the partial index as witness; 56 = 56), the ONE chokepoint for the row's second child (`insertBooking`
// reads the course; the two clones copy their template — pinned as a CENSUS of every `insert(bookings)`), the create by
// VALUE through a fake tx (both kids guarded, the DUO price group, ONE sale at `course-balance-duo-{size}`, the rate
// stored), the rate edits (course PATCH + the session move; Private ⇒ 400 NOT_DUO), the FOUR private family reads retired
// into ONE `householdLineUserIds` (by value: union, de-duplicated, primary-first; by source: none remains), the notices
// (confirm / cancel / deduction / confirmCourse) reaching both households, the reminder ONCE per household with `A & B`,
// the LIFF reads through ONE `familyRowsWhere`, the leave for child 2's family, CRM to both, SOM both, the pool untouched,
// group DUO retired for CREATION only. Group (3–12) byte-unchanged.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApiException } from "./http";
import { courseKindOf, duoStudentIds, familyRowsWhere, joinChildNames, NOT_A_COURSE_SESSION } from "./duo-course";
import { householdLineUserIds } from "./family-link";
import { groupReminders } from "./daily-reminder";
import { childrenWithSessions, needsChildStep } from "./line-leave";
import { GROUP_KINDS, GROUP_KINDS_CREATABLE, OTHER_KINDS } from "./other-kind";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { GROUP_KIND_PRICE_GROUP, courseItemRef } from "./sale-items";
import * as salePost from "./sale-post";
import * as v from "../validation";
import * as sched from "../services/scheduler.service";
import * as parentSvc from "../services/parent.service";
import { db } from "../db";
import { bookings, coursePackages } from "../db/schema";
import { toBookingDTO, toCourseWithStudent } from "../db/mappers";
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
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const json = (method: string, path: string, body?: unknown) =>
  rootApp.fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const SCHED = code(src("src/services/scheduler.service.ts"));
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", SUBJ = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", GK = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });

describe("🔴 the migration — 0048, counted, three NULLABLE adds, two RESTRICT FKs, the partial index LAST = the witness; the SHARE lock named (source)", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
  const sql = readFileSync(resolve(root, "drizzle/0048_duo_course.sql"), "utf8").replace(/\r\n/g, "\n");
  const body = sql.replace(/^--.*$/gm, "");
  test("56 = 56: `0048_duo_course` is the 49th file, idx 48 (TASK-428 added 0049 after it); 'expects 49'", () => {
    expect(files.length).toBe(57);
    expect(journal.entries.length).toBe(57);
    expect(files[48]).toBe("0048_duo_course.sql");
    expect(journal.entries[48]).toMatchObject({ idx: 48, tag: "0048_duo_course" });
    expect(sql).toContain("`db:verify` expects 49");
    expect(sql).toContain("`0038` → … → `0047` → THIS");
  });
  test("the objects: co_student_id + class_rate_minor on course_packages, co_student_id on bookings (RESTRICT to students), the partial index LAST; every object IF NOT EXISTS", () => {
    const stmts = sql.split("--> statement-breakpoint").map((s) => s.replace(/^--.*$/gm, "").trim()).filter(Boolean);
    expect(stmts).toHaveLength(4);
    expect(stmts[0]).toBe('ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "co_student_id" uuid NULL REFERENCES "students"("id") ON DELETE RESTRICT;');
    expect(stmts[1]).toBe('ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "class_rate_minor" integer NULL;');
    expect(stmts[2]).toBe('ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "co_student_id" uuid NULL REFERENCES "students"("id") ON DELETE RESTRICT;');
    expect(stmts[3]).toBe('CREATE INDEX IF NOT EXISTS "bookings_co_student_idx" ON "bookings" ("co_student_id") WHERE "co_student_id" IS NOT NULL;');
    expect(body).not.toMatch(/DEFAULT|integer NOT NULL|uuid NOT NULL|CASCADE|CREATE TYPE|UPDATE /); // nullable adds, no rewrite; `IS NOT NULL` is the index predicate
  });
  test("the witness is the LAST entry, probes the index; the SHARE lock on `bookings` is said in the header", () => {
    const last = SCHEDULING_WITNESSES.find((w) => w.tag === "0048_duo_course")!; // 🔻 TASK-428: 0049 is the last now
    expect(last).toMatchObject({ tag: "0048_duo_course", probe: { kind: "index", index: "bookings_co_student_idx" }, rerunnable: true });
    expect(sql).toContain("SHARE lock for its one scan");
    expect(sql).toContain("Not `CONCURRENTLY`");
  });
  test("the schema: both columns, both relations NAMED (two one(students) on a table), the students' many() named to match", () => {
    const S = code(src("src/db/schema.ts"));
    expect((S.match(/coStudentId: uuid\("co_student_id"\)\.references\(\(\) => students\.id, \{ onDelete: "restrict" \}\),/g) ?? []).length).toBe(2); // course_packages + bookings
    expect(S).toContain('classRateMinor: integer("class_rate_minor"),');
    expect(S).toContain('coStudent: one(students, { fields: [coursePackages.coStudentId], references: [students.id], relationName: "course_co_student" }),');
    expect(S).toContain('coStudent: one(students, { fields: [bookings.coStudentId], references: [students.id], relationName: "booking_co_student" }),');
    expect(S).toContain('bookings: many(bookings, { relationName: "booking_student" }),');
    expect(S).toContain('coursePackages: many(coursePackages, { relationName: "course_student" }),');
  });
});

describe("🔴 THE CHOKEPOINT — a CENSUS of every `insert(bookings)`: the ONE inserter reads the course's second child; each clone copies its template (source)", () => {
  test("three sites in src (outside seed/tests), all in scheduler.service", () => {
    const walk = (d: string): string[] => readdirSync(resolve(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    const hits = walk("src").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith("db/seed.ts")).filter((f) => code(src(f)).includes("insert(bookings)"));
    expect(hits).toEqual(["src/services/scheduler.service.ts"]);
    expect((SCHED.match(/\.insert\(bookings\)/g) ?? []).length).toBe(3);
  });
  test("🔴 every site is either INSIDE `insertBooking` or a `.values` that names `coStudentId` (the census)", () => {
    const inserter = region(SCHED, "export async function insertBooking(", "\n}\n");
    let at = -1;
    const sites: string[] = [];
    while ((at = SCHED.indexOf(".insert(bookings)", at + 1)) >= 0) {
      const values = SCHED.slice(at, SCHED.indexOf(".returning(", at));
      const inside = at > SCHED.indexOf(inserter) && at < SCHED.indexOf(inserter) + inserter.length;
      sites.push(inside ? "inserter" : values.includes("coStudentId: template.coStudentId ?? null") ? "clone:reconcile" : values.includes("coStudentId: current.coStudentId ?? null") ? "clone:sick-leave" : "UNCOVERED");
    }
    expect(sites.sort()).toEqual(["clone:reconcile", "clone:sick-leave", "inserter"]);
  });
  test("`insertBooking`: the fallback read — the caller's `coStudentId`, else the COURSE's (one read when `courseId` is set), else null; written in `.values`", () => {
    const I = region(SCHED, "export async function insertBooking(", "\n}\n");
    expect(I).toContain("const coStudentId: string | null = input.coStudentId ?? (input.courseId ? await courseCoStudentId(exec, input.courseId) : null);");
    expect(I).toContain("        groupId: input.groupId ?? null,\n        coStudentId,\n");
    const R = region(SCHED, "async function courseCoStudentId(", "\n}\n");
    expect(R).toContain("columns: { coStudentId: true }");
    expect(R).toContain("return c?.coStudentId ?? null;");
  });
  test("the two clones sit where they always did — the reconcile's EXTENDED append and the sick-leave make-up — and copy, never read", () => {
    const REC = region(SCHED, "export async function reconcileCoursePlan(", "\n}\n");
    expect(REC).toContain("studentId: template.studentId,\n          coStudentId: template.coStudentId ?? null,");
    const SICK = region(SCHED, '} else if (action === "sick-leave"', "for (const sid of duoStudentIds(current))");
    expect(SICK).toContain("studentId: current.studentId,\n              coStudentId: current.coStudentId ?? null,");
    expect(REC + SICK).not.toContain("courseCoStudentId(");
  });
});

describe("🔴 the create by VALUE through a fake tx — both kids guarded, the DUO price group, ONE sale at `course-balance-duo-{size}` (refId = the course), the rate STORED", () => {
  const fakeCreate = (opts: { archived?: Set<string> } = {}) => {
    const inserted: Array<{ table: string; v: any }> = [];
    let n = 0;
    const tx: any = {
      insert: (table: any) => ({ values: (val: any) => ({ returning: async () => { const id = table === coursePackages ? "course-1" : `b-${++n}`; inserted.push({ table: table === coursePackages ? "coursePackages" : table === bookings ? "bookings" : "other", v: val }); return [{ id }]; } }) }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
      query: {
        students: { findFirst: async ({ where }: any) => { const probe: string[] = []; where({ id: "id" }, { eq: (_: any, x: string) => { probe.push(x); return null; } }); const id = probe[0]!; return { id, parentId: null, archivedAt: opts.archived?.has(id) ? new Date() : null, name: id === A ? "Ploy" : "Pun", nickname: id === A ? "Ploy" : "Pun" }; } },
        teachers: { findFirst: async () => ({ id: T1, nickname: "Bank", name: "Bank", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME" }) },
        // 🔻 TASK-453 — the Private's insert now asks "is an EMPTY group row holding this hour?" before it writes.
        // `null` = no group row on that hour, which is this course's case (and every Private's, ordinarily).
        bookings: { findFirst: async () => null, findMany: async () => inserted.filter((r) => r.table === "bookings").map((r, i) => ({ id: `b-${i + 1}`, ...r.v, status: r.v.status ?? "PENDING", student: { id: A, name: "Ploy" }, coStudent: r.v.coStudentId ? { id: B, name: "Pun" } : null, teacher: { id: T1, nickname: "Bank", name: "Bank" }, subject: { id: SUBJ, name: "Balance" }, course: null, badges: [], additionalTeachers: [], rental: null, seats: [], group: null, campWeekDay: null })) },
        coursePackages: { findFirst: async () => { const c = inserted.find((r) => r.table === "coursePackages")!.v; return { id: "course-1", ...c, usedSessions: 0, leaveUsed: 0, adminUnlocked: false, priorSessions: 0, leaveQuota: null, createdAt: new Date(), student: { id: A, name: "Ploy", nickname: "Ploy" }, coStudent: c.coStudentId ? { id: B, name: "Pun", nickname: "Pun" } : null, subject: { id: SUBJ, name: "Balance" } }; } },
      },
    };
    return { tx, inserted };
  };
  const body = { student: { id: A }, teacherId: T1, subjectId: SUBJ, size: 4, startDate: "2026-10-05", startTime: "10:00" };
  test("DUO: the course row carries coStudentId + classRateMinor; all four rows carry coStudentId; both children pass `assertStudentActive`; the sale is `course-balance-duo-4` with refId = the course; the DTO says DUO", async () => {
    const { tx, inserted } = fakeCreate();
    const sales: any[] = [];
    const active: string[] = [];
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    spies.push(spyOn(salePost, "recordSale").mockImplementation((async (...args: any[]) => { sales.push(args); return { status: "posted" } as any; }) as any));
    spies.push(spyOn(parentSvc, "assertStudentActive").mockImplementation((async (_e: any, id: string) => { active.push(id); }) as any));
    spies.push(spyOn(db.query.subjects, "findFirst").mockImplementation((async () => ({ id: SUBJ, priceGroup: "balance-duo", kind: "DUO" })) as any)); // 🔻 TASK-437: a DUO create needs a DUO subject
    const out = await sched.createCoursePackage({ ...body, duo: { coStudentId: B, classRateMinor: 40000 } });
    const course = inserted.find((r) => r.table === "coursePackages")!.v;
    expect(course).toMatchObject({ studentId: A, coStudentId: B, classRateMinor: 40000, size: 4, subjectId: SUBJ });
    const rows = inserted.filter((r) => r.table === "bookings").map((r) => r.v);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.coStudentId === B && r.courseId === "course-1" && r.studentId === A)).toBe(true);
    expect(active).toEqual([A, B]);
    expect(sales).toHaveLength(1);
    expect(sales[0]![0]).toBe("course-balance-duo-4");
    expect(sales[0]![2]).toMatchObject({ refId: "course-1", idempotencyKey: "course-sale:course-1" });
    expect(out.course).toMatchObject({ courseKind: "DUO", classRateMinor: 40000, coStudent: { id: B, name: "Pun" }, student: { id: A } });
    expect(out.bookings.every((b: any) => b.coStudent?.id === B)).toBe(true);
  });
  test("Private (no `duo`): null in all three, the private price group's item, the DTO says PRIVATE", async () => {
    const { tx, inserted } = fakeCreate();
    const sales: any[] = [];
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    spies.push(spyOn(salePost, "recordSale").mockImplementation((async (...args: any[]) => { sales.push(args); return { status: "posted" } as any; }) as any));
    spies.push(spyOn(parentSvc, "assertStudentActive").mockImplementation((async () => {}) as any));
    spies.push(spyOn(db.query.subjects, "findFirst").mockImplementation((async () => ({ id: SUBJ, priceGroup: "bike-skate" })) as any));
    const out = await sched.createCoursePackage(body);
    expect(inserted.find((r) => r.table === "coursePackages")!.v).toMatchObject({ coStudentId: null, classRateMinor: null });
    expect(inserted.filter((r) => r.table === "bookings").every((r) => r.v.coStudentId === null)).toBe(true);
    expect(sales[0]![0]).toBe("course-bike-skate-4");
    expect(out.course).toMatchObject({ courseKind: "PRIVATE", classRateMinor: null, coStudent: null });
  });
  test("the same child twice ⇒ 400 DUO_SAME_CHILD, before any row; an archived co-student ⇒ the STUDENT_ARCHIVED conflict from the ONE guard", async () => {
    const { tx, inserted } = fakeCreate();
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    spies.push(spyOn(salePost, "recordSale").mockImplementation((async () => ({ status: "posted" })) as any));
    spies.push(spyOn(db.query.subjects, "findFirst").mockImplementation((async () => ({ id: SUBJ, priceGroup: "balance-duo", kind: "DUO" })) as any)); // 🔻 TASK-437
    const guard = spyOn(parentSvc, "assertStudentActive").mockImplementation((async (_e: any, id: string) => { if (id === B) throw new ApiException(409, "STUDENT_ARCHIVED", "archived"); }) as any);
    spies.push(guard);
    await expect(sched.createCoursePackage({ ...body, duo: { coStudentId: A, classRateMinor: 0 } })).rejects.toMatchObject({ status: 400, code: "DUO_SAME_CHILD" });
    expect(inserted).toHaveLength(0);
    await expect(sched.createCoursePackage({ ...body, duo: { coStudentId: B, classRateMinor: 0 } })).rejects.toMatchObject({ status: 409, code: "STUDENT_ARCHIVED" });
    expect(inserted).toHaveLength(0);
  });
  test("by source: the price group is `input.duo ? \"DUO\" : courseGroupKind`; the co-student's household passes the suspension guard; the write names both facts", () => {
    const C = region(SCHED, "export async function createCoursePackage(", "\n}\n");
    expect(C).toContain('const priceGroup = await resolvePriceGroup(input.subjectId, input.duo ? "DUO" : courseGroupKind);');
    expect(C).toContain("if (coStudentId === studentId) throw DUO_SAME_CHILD();\n      await assertStudentActive(tx, coStudentId);\n      await assertHouseholdNotSuspended(tx, coStudentId);");
    expect(C).toContain("classRateMinor: input.duo?.classRateMinor ?? null,"); // 🔻 TASK-434: optional at create
    expect(C).toContain("with: { student: true, coStudent: true },");
    expect(C).not.toMatch(/classRateMinor[^\n]*recordSale|recordSale[^\n]*classRateMinor/); // the rate is never posted
  });
});

describe("🔴 the validators — `duo`, `duo` + `groupKey` ⇒ 400, the rate edits; group DUO retired for CREATION only", () => {
  const course = { student: { id: A }, teacherId: T1, subjectId: SUBJ, size: 4, startDate: "2026-10-05", startTime: "10:00" };
  test("`createCoursePackage.duo` = { coStudentId, classRateMinor ≥ 0 }; with `groupKey` ⇒ refused", () => {
    expect(v.createCoursePackage.safeParse({ ...course, duo: { coStudentId: B, classRateMinor: 40000 } }).success).toBe(true);
    expect(v.createCoursePackage.safeParse({ ...course, duo: { coStudentId: B, classRateMinor: 0 } }).success).toBe(true);
    expect(v.createCoursePackage.safeParse({ ...course, duo: { coStudentId: B, classRateMinor: -1 } }).success).toBe(false);
    expect(v.createCoursePackage.safeParse({ ...course, duo: { coStudentId: B, classRateMinor: 1.5 } }).success).toBe(false);
    expect(v.createCoursePackage.safeParse({ ...course, duo: { coStudentId: B } }).success).toBe(true); // 🔻 TASK-434 (REQ-102 §8): the rate is OPTIONAL at create
    expect(v.createCoursePackage.safeParse({ ...course, duo: { coStudentId: "nope", classRateMinor: 1 } }).success).toBe(false);
    const both = v.createCoursePackage.safeParse({ ...course, groupKey: GK, duo: { coStudentId: B, classRateMinor: 1 } });
    expect(both.success).toBe(false);
    expect(JSON.stringify(both.success ? null : both.error.issues)).toContain("คอร์ส DUO ขายเข้ากลุ่มไม่ได้");
    expect(v.createCoursePackage.safeParse({ ...course, groupKey: GK }).success).toBe(true); // a course INTO a group still sells
  });
  test("`updateCourse.classRateMinor` and `moveBooking.classRateMinor`: integers ≥ 0, optional", () => {
    expect(v.updateCourse.safeParse({ classRateMinor: 35000 }).success).toBe(true);
    expect(v.updateCourse.safeParse({ classRateMinor: -1 }).success).toBe(false);
    expect(v.updateCourse.safeParse({ classRateMinor: null }).success).toBe(false); // the default is set, never cleared
    expect(v.updateCourse.safeParse({ adminUnlocked: true }).success).toBe(true);
    expect(v.moveBooking.safeParse({ classRateMinor: 35000 }).success).toBe(true);
    expect(v.moveBooking.safeParse({ classRateMinor: null }).success).toBe(true); // 🔻 TASK-423: null clears the session's override
    expect(v.moveBooking.safeParse({ classRateMinor: -5 }).success).toBe(false);
    expect(v.moveBooking.safeParse({}).success).toBe(false);
  });
  test("group DUO: `GROUP_KINDS_CREATABLE` = [GROUP] on the series validator; `GROUP_KINDS` (readers) and `OTHER_KINDS` unchanged; the DUO price group still maps", () => {
    expect([...GROUP_KINDS_CREATABLE]).toEqual(["GROUP"]);
    expect([...GROUP_KINDS]).toEqual(["DUO", "GROUP"]);
    expect([...OTHER_KINDS]).toEqual(["ECA", "FREE", "KOL", "CAMP"]);
    const base = { name: "x", groupKind: "GROUP", seatCap: 6, teacherId: T1, startTime: "10:00", dates: ["2026-10-01"] };
    expect(v.groupSeries.safeParse(base).success).toBe(true);
    expect(v.groupSeries.safeParse({ ...base, groupKind: "DUO", seatCap: 2 }).success).toBe(false);
    expect(code(src("src/validation.ts"))).toContain("groupKind: z.enum(GROUP_KINDS_CREATABLE),");
    expect(GROUP_KIND_PRICE_GROUP).toEqual({ DUO: "balance-duo", GROUP: "balance-group" });
  });
  test("an EXISTING DUO series is still read as DUO — `groupKindOf` by value; the seat-cap rule of the sweep untouched", async () => {
    const exec = { query: { bookings: { findFirst: async () => ({ bookingType: "GROUP", otherKind: "DUO" }) } } };
    expect(await sched.groupKindOf(exec, GK)).toBe("DUO");
    expect(await sched.resolvePriceGroup(SUBJ, "DUO", { query: { subjects: { findFirst: async () => { throw new Error("must not read"); } } } })).toBe("balance-duo");
    expect(courseItemRef("balance-duo", 4)).toBe("course-balance-duo-4");
  });
});

describe("🔑 the routes through the ROOT app (service spied): POST /courses { duo }, PATCH /courses/:id { classRateMinor }, PATCH /bookings/:id { classRateMinor }", () => {
  const course = { student: { id: A }, teacherId: T1, subjectId: SUBJ, size: 4, startDate: "2026-10-05", startTime: "10:00" };
  test("POST /courses passes `duo` through; `duo` + `groupKey` ⇒ 400 before the service", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    spies.push(spyOn(sched, "createCoursePackage").mockImplementation((async (input: any) => { calls.push(input); return { course: { id: "c" }, bookings: [] }; }) as any));
    const ok = await json("POST", "/courses", { ...course, duo: { coStudentId: B, classRateMinor: 40000 } });
    expect(ok.status).toBe(201);
    expect(calls[0]).toMatchObject({ duo: { coStudentId: B, classRateMinor: 40000 } });
    const bad = await json("POST", "/courses", { ...course, groupKey: GK, duo: { coStudentId: B, classRateMinor: 40000 } });
    expect(bad.status).toBe(400);
    expect(calls).toHaveLength(1);
  });
  test("PATCH /courses/:id { classRateMinor } and PATCH /bookings/:id { classRateMinor | null } reach their services; a non-course row's 400 NOT_A_COURSE_SESSION passes through as the envelope (🔻 TASK-423)", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    spies.push(spyOn(sched, "updateCourse").mockImplementation((async (id: string, input: any) => { calls.push(["course", id, input]); return { id }; }) as any));
    spies.push(spyOn(sched, "moveBooking").mockImplementation((async (id: string, input: any) => { calls.push(["booking", id, input]); if (id === uuidFor("trial")) throw NOT_A_COURSE_SESSION(); return { id }; }) as any));
    expect((await json("PATCH", `/courses/${uuidFor("duo-1")}`, { classRateMinor: 35000 })).status).toBe(200);
    expect((await json("PATCH", `/bookings/${uuidFor("b-1")}`, { classRateMinor: 35000 })).status).toBe(200);
    expect((await json("PATCH", `/bookings/${uuidFor("b-1")}`, { classRateMinor: null })).status).toBe(200);
    const trial = await json("PATCH", `/bookings/${uuidFor("trial")}`, { classRateMinor: 300 });
    expect(trial.status).toBe(400);
    expect(((await trial.json()) as any).error.code).toBe("NOT_A_COURSE_SESSION");
    expect(calls).toEqual([["course", uuidFor("duo-1"), { classRateMinor: 35000 }], ["booking", uuidFor("b-1"), { classRateMinor: 35000 }], ["booking", uuidFor("b-1"), { classRateMinor: null }], ["booking", uuidFor("trial"), { classRateMinor: 300 }]]);
  });
});

// 🔻 TASK-423 — the rate's two writes moved: the session's override lives on the ROW (`teacher_rate_minor`), the course's
// default on the course, any course. Pinned by value in `coach-rate-req095-13-3.test.ts`; TASK-420's DUO-only block retired.
describe("🔴 the ONE household accessor — by VALUE (union, de-duplicated, primary-first, nulls skipped) and by SOURCE (no private read remains)", () => {
  const exec = (o: { student: Record<string, string | null>; parents: Record<string, { lineUserId: string | null; links: string[] }> }) => ({
    query: {
      students: { findMany: async () => Object.entries(o.student).map(([id, parentId]) => ({ id, parentId })) },
      parents: { findMany: async () => Object.entries(o.parents).map(([id, p]) => ({ id, lineUserId: p.lineUserId })) },
    },
    select: () => ({ from: () => ({ where: async () => Object.entries(o.parents).flatMap(([parentId, p]) => p.links.map((lineUserId) => ({ parentId, lineUserId }))) }) }),
  });
  test("two households ⇒ the union, the primary child's first; siblings ⇒ once; a null / unparented / unlinked child adds nothing", async () => {
    const e = exec({ student: { A: "p1", B: "p2", C: "p1", D: null }, parents: { p1: { lineUserId: "U1", links: ["U1b"] }, p2: { lineUserId: null, links: ["U2"] }, p3: { lineUserId: "U3", links: [] } } });
    expect(await householdLineUserIds(e, ["A", "B"])).toEqual(["U1", "U1b", "U2"]);
    expect(await householdLineUserIds(e, ["B", "A"])).toEqual(["U2", "U1", "U1b"]);
    expect(await householdLineUserIds(e, ["A", "C"])).toEqual(["U1", "U1b"]);
    // one device linked to BOTH households (a grandparent's phone) ⇒ one copy, in the primary's position
    const shared = exec({ student: { A: "p1", B: "p2" }, parents: { p1: { lineUserId: "U1", links: ["Ug"] }, p2: { lineUserId: "U2", links: ["Ug"] } } });
    expect(await householdLineUserIds(shared, ["A", "B"])).toEqual(["U1", "Ug", "U2"]);
    expect(await householdLineUserIds(e, ["A", null])).toEqual(["U1", "U1b"]);
    expect(await householdLineUserIds(e, ["D", undefined])).toEqual([]);
    expect(await householdLineUserIds(e, [null, null])).toEqual([]);
    expect(await householdLineUserIds(e, ["Z"])).toEqual([]);
  });
  test("🔴 by source: `parentLineUserIds` and `familyAccountsOfStudent` are GONE; every notice site asks `householdLineUserIds` with BOTH ids", () => {
    const DED = code(src("src/lib/course-deduction.ts"));
    expect(SCHED).not.toMatch(/parentLineUserIds\(|familyAccountsOfStudent\(|familyLineUserIds\(/);
    expect(DED).not.toMatch(/familyAccountsOfStudent\(|familyLineUserIds\(/);
    expect(DED).toContain("const accounts = await householdLineUserIds(exec, [input.studentId, input.coStudentId ?? null]);");
    expect(SCHED).toContain("await enqueueParentCopies(tx, await householdLineUserIds(tx, [current.studentId, current.coStudentId]), {"); // the single confirm
    expect(SCHED).toContain("const parentLines = confirmed ? await householdLineUserIds(tx, [student?.id ?? course.studentId, course.coStudentId]) : [];"); // confirmCourse
    expect(SCHED).toContain("const accounts = await householdLineUserIds(tx, ids);"); // the cancel — 🔻 TASK-445: ONE set for the row (a GROUP row's seats too), the accounts returned for the counts
    expect(SCHED).toContain("await enqueueParentCopies(tx, accounts, { bookingId: current.id, payload });");
    expect((SCHED.match(/householdLineUserIds\(/g) ?? []).length).toBe(3);
    // the ONE accessor lives beside the family's other accessors, on the bulk read
    const FL = code(src("src/lib/family-link.ts"));
    expect(region(FL, "export async function householdLineUserIds(", "\n}\n")).toContain("const byParent = await familyLineUserIdsBulk(parentIds, exec);");
    // the four deduction call sites hand the second child over
    expect((SCHED.match(/coStudentId: current\.coStudentId \?\? null, \/\/ TASK-420\n\s+kind: "(course|voucher)"/g) ?? []).length).toBe(2);
    const JOBS = code(src("src/services/jobs.service.ts"));
    expect((JOBS.match(/coStudentId: b\.coStudentId \?\? null, \/\/ TASK-420\n\s+kind: "(course|voucher)"/g) ?? []).length).toBe(2);
    expect(JOBS).toContain("coStudentId: bookings.coStudentId, // TASK-420"); // the day-end's explicit select carries it
  });
  test("the family cancel sender by value: a DUO row reaches BOTH households in one batch (de-duplicated); a GROUP row still one batch per seat", async () => {
    const inserted: any[] = [];
    const tx = (o: { seats?: { studentId: string }[]; student: Record<string, string | null>; parents: Record<string, { lineUserId: string | null; links: string[] }> }) => ({
      ...exec(o),
      insert: () => ({ values: async (val: any) => { inserted.push(val); } }),
      query: { ...exec(o).query, bookings: { findMany: async () => o.seats ?? [] } },
    });
    const fam = { student: { A: "p1", B: "p2", C: "p1" }, parents: { p1: { lineUserId: "U1", links: [] }, p2: { lineUserId: "U2", links: ["U2b"] } } };
    expect(await sched.sendClassCancelledToFamilies(tx(fam), { id: uuidFor("b-1"), status: "CONFIRMED", studentId: "A", coStudentId: "B", bookingType: "COURSE_PACKAGE", course: { size: 4 } }, "ADMIN_ERROR")).toBe(1);
    expect(inserted.map((r) => r.recipientLineUserId)).toEqual(["U1", "U2", "U2b"]);
    inserted.length = 0;
    expect(await sched.sendClassCancelledToFamilies(tx(fam), { id: "b-2", status: "CONFIRMED", studentId: "A", coStudentId: "C", bookingType: "COURSE_PACKAGE", course: { size: 4 } }, "ADMIN_ERROR")).toBe(1);
    expect(inserted.map((r) => r.recipientLineUserId)).toEqual(["U1"]); // siblings: the household once
    inserted.length = 0;
    expect(await sched.sendClassCancelledToFamilies(tx({ ...fam, seats: [{ studentId: "A" }, { studentId: "B" }] }), { id: "g-1", status: "CONFIRMED", studentId: null, bookingType: "GROUP" }, "ADMIN_ERROR")).toBe(1); // 🔻 TASK-445: ONE household set per row (the count = the row's families were told); the accounts still all three, each ONCE
    expect(inserted.map((r) => r.recipientLineUserId)).toEqual(["U1", "U2", "U2b"]);
  });
});

describe("🔴 the reminder — ONCE per household with `A & B`; the LIFF reads through ONE predicate; the leave for child 2's family; CRM to both", () => {
  const s = (over: any) => ({ id: "b", date: "2026-10-05", startTime: "10:00:00", status: "CONFIRMED", teacherId: T1, teacherLineUserId: "UT", studentId: A, studentName: "Ploy & Pun", parentId: "p1", parentLineUserId: "U1", parentLineUserIds: ["U1", "U1b"], subjectName: "Balance", ...over });
  test("`groupReminders` by value: two households ⇒ the row in both parent groups (each with its own accounts); siblings ⇒ one group, the row once; the teacher once", () => {
    const two = groupReminders([s({ coParentId: "p2", coParentLineUserIds: ["U2"] })]);
    const parents = two.filter((g) => g.recipientType === "parent");
    expect(parents.map((g) => [g.personId, g.lineUserIds, g.rows.length])).toEqual([["p1", ["U1", "U1b"], 1], ["p2", ["U2"], 1]]);
    expect(parents.every((g) => g.rows[0]!.studentName === "Ploy & Pun")).toBe(true);
    expect(two.filter((g) => g.recipientType === "teacher")).toHaveLength(1);
    const sib = groupReminders([s({ coParentId: "p1", coParentLineUserIds: ["U1", "U1b"] })]);
    expect(sib.filter((g) => g.recipientType === "parent").map((g) => [g.personId, g.rows.length])).toEqual([["p1", 1]]);
    const priv = groupReminders([s({ studentName: "Ploy" })]);
    expect(priv.filter((g) => g.recipientType === "parent").map((g) => [g.personId, g.rows.length])).toEqual([["p1", 1]]);
  });
  test("the job by source: `coStudent` loaded, both parents in the ONE bulk read, the name joined with `&`, the second household handed to the grouper", () => {
    const J = code(src("src/services/jobs.service.ts"));
    const R = region(J, "export async function runDailyReminderJob(", "\n}\n");
    expect(R).toContain("      student: true,\n      coStudent: true,");
    expect(R).toContain("const parentIds = [...new Set(rows.flatMap((r: any) => [r.student?.parentId, r.coStudent?.parentId]).filter(Boolean))] as string[];");
    expect(R).toContain('studentName: displayNameOf(r) || "-",'); // 🔻 TASK-423: the ONE name function
    expect(R).toContain("coParentId: r.coStudent?.parentId ?? null,");
    expect(R).toContain("coParentLineUserIds: r.coStudent?.parentId ? (familyAccounts.get(r.coStudent.parentId) ?? []) : [],");
    expect(joinChildNames({ name: "Ploy", nickname: null }, { name: "Punnapa", nickname: "Pun" })).toBe("Ploy & Pun");
    expect(joinChildNames({ name: "Ploy" }, null)).toBe("Ploy");
  });
  test("`familyRowsWhere` — primary OR co-student, one predicate; both LIFF windows use it and load `coStudent`", () => {
    const q = familyRowsWhere([A, B]);
    const sql = (db as any).dialect.sqlToQuery(q);
    expect(sql.sql).toBe('("bookings"."student_id" in ($1, $2) or "bookings"."co_student_id" in ($3, $4))');
    expect(sql.params).toEqual([A, B, A, B]);
    const C = code(src("src/services/checkin.service.ts"));
    for (const fn of ["export async function findTodayBookingsForParent(", "export async function findUpcomingBookingsForParent("]) {
      const F = region(C, fn, "\n}\n");
      expect(F).toContain("familyRowsWhere(ids)");
      expect(F).toContain("with: { student: true, coStudent: true, teacher: true, subject: true },");
      expect(F).not.toContain("inArray(b.studentId");
    }
    expect(C).toContain("for (const sid of duoStudentIds(row)) await awardCrmPoints(sid, CRM_POINT_RULES.ON_TIME_CHECKIN);");
    expect(C).toContain("export async function linkedStudentIds(lineUserId: string): Promise<string[]> {");
  });
  test("the leave: authorize as primary OR co-student; the child picker offers THIS family's children only (by value + source); my-courses matches either child", () => {
    const rows: any[] = [
      { id: "1", studentId: A, coStudentId: B, date: "2026-10-05", startTime: "10:00", student: { name: "Ploy" }, coStudent: { name: "Punnapa", nickname: "Pun" } },
      { id: "2", studentId: "C", coStudentId: null, date: "2026-10-06", startTime: "10:00", student: { name: "Chai" } },
    ];
    expect(childrenWithSessions(rows)).toEqual([{ studentId: A, name: "Ploy" }, { studentId: B, name: "Pun" }, { studentId: "C", name: "Chai" }]);
    expect(childrenWithSessions(rows, new Set([B]))).toEqual([{ studentId: B, name: "Pun" }]); // child 2's family sees only Pun
    expect(childrenWithSessions(rows, new Set([A, "C"]))).toEqual([{ studentId: A, name: "Ploy" }, { studentId: "C", name: "Chai" }]);
    expect(needsChildStep(rows)).toBe(true);
    const W = code(src("src/services/line-webhook.service.ts"));
    const L = region(W, "async function doLeave(", "\n}\n");
    expect(L).toContain("eligible = eligible.filter((b) => b.studentId === studentId || b.coStudentId === studentId);");
    expect(L).toContain("const own = new Set(await linkedStudentIds(lineUserId));");
    expect(L).toContain("childrenWithSessions(eligible, own)");
    expect(region(W, "async function doMyCourses(", "\n}\n")).toContain("o(inA(c.studentId, kids.map((k: any) => k.id)), inA(c.coStudentId, kids.map((k: any) => k.id)))");
  });
  test("CRM at the sick-leave to both kids (source); `duoStudentIds` / `courseKindOf` by value", () => {
    expect(SCHED).toContain("for (const sid of duoStudentIds(current)) await awardCrmPoints(sid, CRM_POINT_RULES.PROPER_SICK_LEAVE, tx);");
    expect(duoStudentIds({ studentId: A, coStudentId: B })).toEqual([A, B]);
    expect(duoStudentIds({ studentId: A, coStudentId: null })).toEqual([A]);
    expect(duoStudentIds({ studentId: null, coStudentId: null })).toEqual([]);
    expect(courseKindOf({ coStudentId: B })).toBe("DUO");
    expect(courseKindOf({ coStudentId: null })).toBe("PRIVATE");
    expect(courseKindOf(null)).toBe("PRIVATE");
  });
});

describe("🔴 the READERS by source — the 16-site table; the DTOs; the pool untouched by absence", () => {
  const PS = code(src("src/services/parent.service.ts"));
  const SQ = code(src("src/services/search.queries.ts"));
  const SOM = code(src("src/services/som-report.service.ts"));
  const MAP = code(src("src/db/mappers.ts"));
  test.each([
    ["withBookingRelations loads coStudent", SCHED, "const withBookingRelations = {\n  student: true,\n  coStudent: true,"],
    ["coursesByIds loads coStudent (the course list / view)", SCHED, "with: { student: true, coStudent: true, subject: true, bookings: { with: { subject: true }, limit: 1 } },"],
    ["the eligible picker offers BOTH children", SCHED, ".flatMap((c: any) => [c.student, c.coStudent].filter(Boolean).map((s: any) => ({ c, s })))"],
    ["updateCourse returns coStudent", SCHED, "with: { student: true, coStudent: true },\n  });\n  if (!row) throw notFound"],
    ["toBookingDTO.coStudent", MAP, "coStudent: b.coStudent ? studentRef(b.coStudent) : null,"],
    ["the ONE builder of the three DUO facts (TASK-422: shared by the course DTO and the plan)", MAP, "export const duoCourseFacts = (c: any) => ({\n  coStudent: c.coStudent ? studentRef(c.coStudent) : null,\n  classRateMinor: c.classRateMinor ?? null,\n  courseKind: courseKindOf(c),\n});"],
    ["toCourseWithStudent spreads the builder", MAP, "  student: studentRef(c.student),\n  ...duoCourseFacts(c), // TASK-420"],
    ["the entitlement plan loads coStudent (TASK-422)", SCHED, "    where: (c, { eq }) => eq(c.id, id),\n    with: { coStudent: true }, // TASK-422"],
    ["the entitlement plan spreads the builder (TASK-422)", SCHED, "      student: studentRef(student),\n      ...duoCourseFacts(course), // TASK-422"],
    ["the course search: the co-student + its parent ride as aliases", SQ, 'const coStudents = alias(students, "co_students");\nconst coParents = alias(parents, "co_parents");'],
    ["the course search matches EITHER child", SQ, "or(...studentSearchConditions(q), ...studentSearchConditionsOn(q, coStudents as any, coParents as any))"],
    ["the course list query joins the co-student", SQ, ".leftJoin(coStudents, eq(coStudents.id, coursePackages.coStudentId))\n    .leftJoin(coParents, eq(coParents.id, coStudents.parentId))\n    .where(courseMatch(q))\n    .orderBy("],
    ["the course count query joins the co-student", SQ, ".leftJoin(coStudents, eq(coStudents.id, coursePackages.coStudentId))\n    .leftJoin(coParents, eq(coParents.id, coStudents.parentId))\n    .where(courseMatch(q));"],
    ["the ONE search rule on an aliased pair", PS, "export function studentSearchConditionsOn(q: string, s: typeof students, p: typeof parents) {"],
    ["the household's live-future count OR co_student_id", PS, "or(inArray(bookings.studentId, studentIds), inArray(bookings.coStudentId, studentIds))"],
    ["the delete-student count OR co_student_id", PS, "table.coStudentId ? or(eq(table.studentId, studentId), eq(table.coStudentId, studentId)) : eq(table.studentId, studentId)"],
    ["SOM byCourse: both children active", SOM, ".flatMap((c: any) => [c.student.id as string, ...(c.coStudent ? [c.coStudent.id as string] : [])])"],
    ["SOM bookingsByStudent: both children", SOM, "for (const sid of duoStudentIds(b)) {"],
    ["SOM entitlements: both children, one course", SOM, "...courses.flatMap((c: any) => [c.student.id as string, ...(c.coStudent ? [c.coStudent.id as string] : [])].map((studentId) => ({ studentId, createdAt: c.createdAt })))"],
  ])("%s", (_name, S, needle) => {
    expect(S).toContain(needle);
  });
  test("the DTOs by value: a row / a course without the relation reads null · PRIVATE; with it, the ref", () => {
    const base = { id: "b", date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", bookingType: "COURSE_PACKAGE", status: "PENDING", teacher: { id: T1, name: "Bank", nickname: "Bank" }, badges: [], additionalTeachers: [] };
    expect(toBookingDTO({ ...base, student: { id: A, name: "Ploy" } }).coStudent).toBeNull();
    expect(toBookingDTO({ ...base, student: { id: A, name: "Ploy" }, coStudent: { id: B, name: "Pun" } }).coStudent).toMatchObject({ id: B, name: "Pun" });
    const c = { id: "c", size: 4, usedSessions: 0, leaveUsed: 0, adminUnlocked: false, expiryDate: "2026-12-31", student: { id: A, name: "Ploy" } };
    expect(toCourseWithStudent(c)).toMatchObject({ courseKind: "PRIVATE", coStudent: null, classRateMinor: null });
    expect(toCourseWithStudent({ ...c, coStudentId: B, coStudent: { id: B, name: "Pun" }, classRateMinor: 40000 })).toMatchObject({ courseKind: "DUO", coStudent: { id: B }, classRateMinor: 40000 });
  });
  test("TASK-422 — the entitlement plan by VALUE: a DUO course ⇒ both refs + the rate + DUO; a Private ⇒ null · null · PRIVATE; the voucher branch untouched", async () => {
    const course = { id: "c-1", size: 4, usedSessions: 0, leaveUsed: 0, adminUnlocked: false, expiryDate: "2026-12-31", studentId: A, startDate: "2026-10-05", weekday: 1, startTime: "10:00:00", priorSessions: 0, leaveQuota: null };
    let duo = true;
    spies.push(spyOn(db.query.coursePackages, "findFirst").mockImplementation((async () => (duo ? { ...course, coStudentId: B, classRateMinor: 40000, coStudent: { id: B, name: "Punnapa", nickname: "Pun" } } : { ...course, coStudentId: null, classRateMinor: null, coStudent: null })) as any));
    spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async () => ({ id: A, name: "Ploy", nickname: "Ploy" })) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => []) as any));
    const d = (await sched.getEntitlementPlan("c-1")) as any;
    expect(d).toMatchObject({ kind: "course", student: { id: A, name: "Ploy" }, coStudent: { id: B, name: "Punnapa", nickname: "Pun" }, classRateMinor: 40000, courseKind: "DUO" });
    duo = false;
    const p = (await sched.getEntitlementPlan("c-1")) as any;
    expect(p).toMatchObject({ kind: "course", coStudent: null, classRateMinor: null, courseKind: "PRIVATE" });
    expect(region(SCHED, "  const voucher = await db.query.vouchers.findFirst({ where: (v, { eq }) => eq(v.id, id) });", "\n}\n")).not.toMatch(/coStudent|duoCourseFacts/);
  });
  test("🚫 the pool untouched: no seat draw, no `groupId` from `duo`, no per-child hours, no new settings key, no posting of the rate; Group (3–12) not narrowed", () => {
    const C = region(SCHED, "export async function createCoursePackage(", "\n}\n");
    expect(C).not.toMatch(/duo[^\n]*seatOnGroup|seatOnGroup[^\n]*duo/);
    expect(SCHED).not.toMatch(/classRateMinor[^\n]*(recordSale|recordRental|enqueueLine)/);
    expect(code(src("src/lib/sale-items.ts"))).not.toContain("class_rate");
    expect(code(src("src/services/settings.service.ts"))).not.toMatch(/duo|class_rate/i);
    expect(code(src("src/validation.ts"))).toContain("seatCap: z.number().int().min(2).max(12).nullable(),"); // 🔻 TASK-453 — `null` = uncapped; the 2..12 rule for a NUMBER is untouched
    expect(code(src("src/db/schema.ts"))).not.toMatch(/hours_per_child|coHours/);
  });
});
