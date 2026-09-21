// TASK-423 (`REQ-095 §13.3`) — the coach rate PER SESSION: the course holds the DEFAULT (`class_rate_minor`), a COURSE_PACKAGE
// row may OVERRIDE it in `bookings.teacher_rate_minor` (REUSED — the OTHER/GROUP primary-teacher rate column; the only
// printer of it, `otherFacts`, is type-gated). `effective = override ?? default` in ONE pure function (`lib/coach-rate.ts`);
// the DTO's three facts under `rate` on course rows only; the session write on the ROW, the course write on the DEFAULT
// (any course); overrides survive a default change; a new row is born with NULL (the default applies). The Bookings-table
// surface (`getBookings`) carries `coStudent` and matches either child; `displayName` is ONE function (`displayNameOf`)
// for the DTO, the reminder and the two slot-clash sentences. No migration (49 = 49); nothing posts.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { effectiveRateMinor, rateFacts } from "./coach-rate";
import { NOT_A_COURSE_SESSION } from "./duo-course";
import * as v from "../validation";
import * as sched from "../services/scheduler.service";
import { db } from "../db";
import { bookings, coursePackages } from "../db/schema";
import { displayNameOf, toBookingDTO } from "../db/mappers";
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
const SCHED = code(src("src/services/scheduler.service.ts"));
const MAP = code(src("src/db/mappers.ts"));
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

describe("🔴 the ONE rule — `effectiveRateMinor` / `rateFacts` by value; no migration", () => {
  test("override · default · neither · zero is a rate", () => {
    expect(effectiveRateMinor({ teacherRateMinor: 300 }, { classRateMinor: 700 })).toBe(300);
    expect(effectiveRateMinor({ teacherRateMinor: null }, { classRateMinor: 700 })).toBe(700);
    expect(effectiveRateMinor({ teacherRateMinor: null }, { classRateMinor: null })).toBeNull();
    expect(effectiveRateMinor({ teacherRateMinor: 0 }, { classRateMinor: 700 })).toBe(0);
    expect(effectiveRateMinor({}, null)).toBeNull();
    expect(effectiveRateMinor(null, undefined)).toBeNull();
  });
  test("`rateFacts`: the three facts on a COURSE_PACKAGE row; null on every other type (the OTHER/GROUP meaning never shares the key)", () => {
    expect(rateFacts({ bookingType: "COURSE_PACKAGE", teacherRateMinor: 300 }, { classRateMinor: 700 })).toEqual({ effectiveMinor: 300, overrideMinor: 300, defaultMinor: 700 });
    expect(rateFacts({ bookingType: "COURSE_PACKAGE", teacherRateMinor: null }, { classRateMinor: 700 })).toEqual({ effectiveMinor: 700, overrideMinor: null, defaultMinor: 700 });
    expect(rateFacts({ bookingType: "COURSE_PACKAGE", teacherRateMinor: null }, null)).toEqual({ effectiveMinor: null, overrideMinor: null, defaultMinor: null });
    for (const t of ["OTHER", "GROUP", "FIRST_TRIAL", "SINGLE_SESSION", "VOUCHER"]) expect(rateFacts({ bookingType: t, teacherRateMinor: 300 }, { classRateMinor: 700 })).toBeNull();
  });
  test("the rule is written ONCE — `lib/coach-rate.ts` holds the only `??` over the two columns; nothing else spells it", () => {
    const CR = code(src("src/lib/coach-rate.ts"));
    expect(CR).toContain("row?.teacherRateMinor ?? course?.classRateMinor ?? null");
    const walk = (d: string): string[] => readdirSync(resolve(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    const others = walk("src").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "src/lib/coach-rate.ts").filter((f) => /teacherRateMinor\s*\?\?\s*[\w.?]*classRateMinor|classRateMinor\s*\?\?\s*[\w.?]*teacherRateMinor/.test(code(src(f))));
    expect(others).toEqual([]);
  });
  test("no migration: 49 = 49; the column is the reused `teacher_rate_minor`", () => {
    expect(readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).length).toBe(49);
    expect(JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")).entries.length).toBe(49);
    expect(code(src("src/db/schema.ts"))).not.toMatch(/rate_override|override_minor/);
  });
});

describe("🔴 the DTO — `rate` on both surfaces; OTHER/GROUP byte-identical; `otherFacts` stays type-gated (a course row's value never prints as a teacher rate)", () => {
  const base = { id: "b", date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", status: "PENDING", teacher: { id: T1, name: "Bank", nickname: "Bank" }, student: { id: A, name: "Ploy" }, badges: [], additionalTeachers: [] };
  test("a course row: override 3 over default 7 ⇒ { 3, 3, 7 }; no override ⇒ { 7, null, 7 }; `other` stays null", () => {
    const d1: any = toBookingDTO({ ...base, bookingType: "COURSE_PACKAGE", teacherRateMinor: 300, course: { id: "c", size: 4, usedSessions: 0, leaveUsed: 0, adminUnlocked: false, expiryDate: "2026-12-31", classRateMinor: 700 } });
    expect(d1.rate).toEqual({ effectiveMinor: 300, overrideMinor: 300, defaultMinor: 700 });
    expect(d1.other).toBeNull();
    const d2: any = toBookingDTO({ ...base, bookingType: "COURSE_PACKAGE", teacherRateMinor: null, course: { id: "c", size: 4, usedSessions: 0, leaveUsed: 0, adminUnlocked: false, expiryDate: "2026-12-31", classRateMinor: 700 } });
    expect(d2.rate).toEqual({ effectiveMinor: 700, overrideMinor: null, defaultMinor: 700 });
  });
  test("an OTHER row: `other.teacherRates` as before, `rate: null`; a 1HR row: both null", () => {
    const o: any = toBookingDTO({ ...base, bookingType: "OTHER", student: null, otherTitle: "ECA", otherKind: "ECA", teacherId: T1, teacherRateMinor: 500 });
    expect(o.other.teacherRates).toEqual({ [T1]: 500 });
    expect(o.rate).toBeNull();
    const s: any = toBookingDTO({ ...base, bookingType: "SINGLE_SESSION" });
    expect(s.rate).toBeNull();
    expect(s.other).toBeNull();
  });
  test("by source: the DTO reads `rateFacts(b, b.course ?? null)`; `otherFacts` gate untouched; the plan/course DTO's `classRateMinor` is the default (unchanged)", () => {
    expect(MAP).toContain("rate: rateFacts(b, b.course ?? null),");
    expect(region(MAP, "const otherFacts = (b: any)", "\n};")).toContain('if (b.bookingType !== "OTHER") return null;');
    expect(MAP).toContain("classRateMinor: c.classRateMinor ?? null,");
  });
});

describe("🔴 the two writes by VALUE — the session ⇒ the ROW's override only; the course ⇒ the DEFAULT only (any course); overrides survive", () => {
  test("`moveBooking { classRateMinor: 300 }` on a course row writes `bookings.teacher_rate_minor` (and nothing on the course); `null` clears it; a non-course row ⇒ 400 NOT_A_COURSE_SESSION before the tx", async () => {
    const row = { id: "b-1", status: "PENDING", courseId: "c-1", coStudentId: null, teacherId: T1, date: "2026-10-05", startTime: "10:00:00", campWeekDayId: null, subjectId: null };
    let current: any = row;
    const updates: any[] = [];
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => current) as any));
    spies.push(spyOn(db.query.coursePackages, "findFirst").mockImplementation((async () => ({ id: "c-1", endedAt: null, droppedAt: null })) as any));
    const tx: any = {
      update: (table: any) => ({ set: (p: any) => ({ where: async () => { updates.push([table === bookings ? "bookings" : table === coursePackages ? "coursePackages" : "other", p]); } }) }),
      query: {
        teachers: { findFirst: async () => ({ id: T1, nickname: "Bank", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME" }) },
        bookings: { findFirst: async () => ({ ...row, teacher: { id: T1 }, student: null, subject: null, course: null, badges: [], additionalTeachers: [], rental: null, seats: [], group: null, campWeekDay: null, coStudent: null }), findMany: async () => [] },
        bookingTeachers: { findMany: async () => [] },
      },
      select: () => ({ from: () => ({ where: async () => [] }) }),
      delete: () => ({ where: async () => {} }),
      insert: () => ({ values: async () => {} }),
    };
    const txSpy = spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any);
    spies.push(txSpy);
    await sched.moveBooking("b-1", { classRateMinor: 300 }).catch((e) => { if (!/reconcile|holds|undefined/.test(String(e?.message ?? e))) throw e; });
    expect(updates.filter(([t]) => t === "bookings").map(([, p]) => p)).toEqual([{ teacherRateMinor: 300 }]);
    expect(updates.filter(([t]) => t === "coursePackages")).toEqual([]);
    updates.length = 0;
    await sched.moveBooking("b-1", { classRateMinor: null }).catch((e) => { if (!/reconcile|holds|undefined/.test(String(e?.message ?? e))) throw e; });
    expect(updates.filter(([t]) => t === "bookings").map(([, p]) => p)).toEqual([{ teacherRateMinor: null }]);
    // a row outside a course: refused before the tx opens
    current = { ...row, courseId: null };
    txSpy.mockClear();
    await expect(sched.moveBooking("b-1", { classRateMinor: 300 })).rejects.toMatchObject({ status: 400, code: "NOT_A_COURSE_SESSION" });
    expect(txSpy).not.toHaveBeenCalled();
    expect(NOT_A_COURSE_SESSION().message).toBe("คาบนี้ไม่ได้อยู่ในคอร์ส — ตั้งค่าสอนไม่ได้");
  });
  test("`updateCourse { classRateMinor: 800 }` writes the DEFAULT on ANY course (the DUO-only refusal is gone) — and only `class_rate_minor`; a session's override is not touched", async () => {
    const sets: any[] = [];
    spies.push(spyOn(db.query.coursePackages, "findFirst").mockImplementation((async () => ({ id: "c-private", coStudentId: null, classRateMinor: 800, size: 4, usedSessions: 0, leaveUsed: 0, adminUnlocked: false, expiryDate: "2026-12-31", endedAt: null, droppedAt: null, student: { id: A, name: "Ploy" }, coStudent: null })) as any));
    spies.push(spyOn(db, "update").mockImplementation(((table: any) => ({ set: (p: any) => { sets.push([table === coursePackages ? "coursePackages" : "other", p]); return { where: async () => {} }; } })) as any));
    const out = await sched.updateCourse("c-private", { classRateMinor: 800 });
    expect(sets).toEqual([["coursePackages", { classRateMinor: 800 }]]);
    expect(out).toMatchObject({ courseKind: "PRIVATE", classRateMinor: 800 });
    // overrides survive: the effective rate of a row with its own 3 is still 3 after the default moved 7 → 8
    expect(effectiveRateMinor({ teacherRateMinor: 300 }, { classRateMinor: 800 })).toBe(300);
  });
  test("by source: the session write is `patch.teacherRateMinor`, refused without a `courseId` BEFORE the tx; no course write in `moveBooking`; `updateCourse` has no `NOT_DUO`; `NOT_DUO` is gone from src", () => {
    const M = region(SCHED, "export async function moveBooking(", "\n}\n");
    expect(M).toContain("if (!current.courseId) throw NOT_A_COURSE_SESSION();\n    patch.teacherRateMinor = input.classRateMinor;");
    expect(M.indexOf("NOT_A_COURSE_SESSION()")).toBeLessThan(M.indexOf("db.transaction("));
    expect(M).not.toMatch(/update\(coursePackages\)|classRateMinor: input/);
    const U = region(SCHED, "export async function updateCourse(", "\n}\n");
    expect(U).toContain("await db.update(coursePackages).set({ classRateMinor: input.classRateMinor }).where(eq(coursePackages.id, id));");
    expect(U).not.toMatch(/coStudentId|courseKindOf|NOT_DUO/);
    expect(SCHED).not.toContain("NOT_DUO");
    expect(code(src("src/lib/duo-course.ts"))).not.toContain("NOT_DUO");
  });
  test("the validators: the session body takes `n | null`; the course body takes `n` only", () => {
    expect(v.moveBooking.safeParse({ classRateMinor: null }).success).toBe(true);
    expect(v.moveBooking.safeParse({ classRateMinor: 0 }).success).toBe(true);
    expect(v.moveBooking.safeParse({ classRateMinor: -1 }).success).toBe(false);
    expect(v.moveBooking.safeParse({ classRateMinor: 300, date: "2026-10-12" }).success).toBe(true); // the move + the rate in one body
    expect(v.updateCourse.safeParse({ classRateMinor: null }).success).toBe(false);
  });
  test("🚫 a new session row is born with NULL — nothing copies the course rate onto a row (the census's three sites)", () => {
    expect(region(SCHED, "export async function insertBooking(", "\n}\n")).toContain("teacherRateMinor: input.teacherRates?.[input.teacherId] ?? null,");
    expect(region(SCHED, "export async function createCoursePackage(", "\n}\n")).not.toMatch(/teacherRates|teacherRateMinor/);
    let at = -1;
    while ((at = SCHED.indexOf(".insert(bookings)", at + 1)) >= 0) {
      const values = SCHED.slice(at, SCHED.indexOf(".returning(", at));
      expect(values).not.toMatch(/classRateMinor|teacherRateMinor: (template|current)/);
    }
  });
  test("🚫 nothing posts: the rate never on a line with a poster; `ratePostedAt` never written", () => {
    expect(SCHED).not.toMatch(/(teacherRateMinor|classRateMinor|effectiveRateMinor|rateFacts)[^\n]*(recordSale|recordRental|enqueueLine|bo\.)/);
    expect(SCHED).not.toMatch(/ratePostedAt:|set\(\{[^}]*ratePostedAt/);
    expect(code(src("src/lib/coach-rate.ts"))).not.toMatch(/import .*(sale|rental|outbox|db)/);
  });
});

describe("🔴 the Bookings-table surface — `coStudent` on the row, either child on `q`; the ONE `displayNameOf`", () => {
  test("`getBookings` by source: the `co_students` alias LEFT-joined (nullable ⇒ LEFT, the DEF-3 rule), handed to the DTO; `q` matches `student_id` OR `co_student_id`", () => {
    const G = region(SCHED, "export async function getBookings(", "\nexport async function getDailyReport(");
    expect(G).toContain('const coStudents = alias(students, "co_students");');
    expect(G).toContain(".leftJoin(coStudents, eq(coStudents.id, bookings.coStudentId))");
    expect(G).toContain("select({ b: bookings, s: students, cs: coStudents, t: teachers, sub: subjects, c: coursePackages })");
    expect(G).toContain("          coStudent: r.cs,");
    expect(G).toContain("ors.push(inArray(bookings.studentId, studentIds), inArray(bookings.coStudentId, studentIds));");
  });
  test("`displayNameOf` by value: the title first; a DUO row `A & B` (nickname first); a lesson row the nickname, then the name; blank only when nothing", () => {
    expect(displayNameOf({ otherTitle: "Camp", student: { name: "Ploy" }, coStudent: { name: "Pun" } })).toBe("Camp");
    expect(displayNameOf({ student: { name: "Ploy" }, coStudent: { name: "Punnapa", nickname: "Pun" } })).toBe("Ploy & Pun");
    expect(displayNameOf({ student: { name: "Ploy", nickname: "Ploy" }, coStudent: null })).toBe("Ploy");
    expect(displayNameOf({ student: { name: "Ploy Sae", nickname: null } })).toBe("Ploy Sae");
    expect(displayNameOf({ student: null })).toBe("");
    // the same string on the relational path (the calendar) and the hand-built row (the table)
    const rel: any = toBookingDTO({ id: "b", date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", bookingType: "COURSE_PACKAGE", status: "PENDING", teacher: { id: T1, name: "Bank", nickname: "Bank" }, badges: [], additionalTeachers: [], student: { id: A, name: "Ploy" }, coStudent: { id: B, name: "Punnapa", nickname: "Pun" } });
    expect(rel.displayName).toBe("Ploy & Pun");
  });
  test("🔴 by source: the DTO, the reminder and BOTH slot-clash sentences call `displayNameOf`; no hand-copied `otherTitle ?? …nickname` chain remains in src", () => {
    expect(MAP).toContain("displayName: displayNameOf(b),");
    expect(code(src("src/services/jobs.service.ts"))).toContain('studentName: displayNameOf(r) || "-",');
    expect(SCHED).toContain("const bookingName = displayNameOf(row);");
    expect(SCHED).toContain("const bookingName = displayNameOf(clash);");
    expect((SCHED.match(/with: \{ teacher: true, student: true, coStudent: true \}/g) ?? []).length).toBe(2); // both clash reads load the co-student
    const walk = (d: string): string[] => readdirSync(resolve(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    const chains = walk("src").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).filter((f) => /otherTitle \?\?[^\n]*(nickname|studentNamesOf)/.test(code(src(f))));
    expect(chains).toEqual(["src/db/mappers.ts"]); // the definition, once (🔻 TASK-425: composed of `studentNamesOf`)
    expect((code(src("src/db/mappers.ts")).match(/otherTitle \?\?[^\n]*(nickname|studentNamesOf)/g) ?? []).length).toBe(1);
  });
});
