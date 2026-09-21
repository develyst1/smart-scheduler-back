// TASK-425 (`REQ-095 §13`, SPEC-087 "A & B everywhere") — the LINE notices named ONE child on a DUO row: the outbox worker's
// `bookingContext` (a FIFTH name path) loaded `student` only, and two payload writers did the same. Now the STUDENT part
// of the ONE name rule — `studentNamesOf(b)` in `db/mappers.ts` (`displayNameOf` = `otherTitle ?? studentNamesOf`) — feeds
// the worker's context, the leave-notice and course-confirmed payloads, and the three other booking-row name sites the
// census made visible (the check-in payload, the ICS feed, the teacher's LINE schedule). Pinned: `bookingContext` by value
// (DUO ⇒ both; Private ⇒ one; OTHER ⇒ no student, the title rides in `program`); the two writers by source; a scan pin that
// every `studentName:` of a BOOKING row goes through the rule; the six renderers by value with a DUO context. 49 = 49.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { formatCheckinPayload } from "./checkin-token";
import { displayNameOf, studentNamesOf } from "../db/mappers";
import { bookingContext } from "../services/outbox.service";
import { db } from "../db";
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
const walk = (d: string): string[] => readdirSync(resolve(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const SCHED = code(src("src/services/scheduler.service.ts"));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const KK = { id: "s1", name: "KKTEST", nickname: null }, PRAO = { id: "s2", name: "Praochompoo", nickname: "Prao" };
const row = (over: any = {}) => ({ id: "b-1", date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", bookingType: "COURSE_PACKAGE", status: "CONFIRMED", otherTitle: null, student: KK, coStudent: PRAO, teacher: { id: "t1", name: "Bank", nickname: "Bank" }, subject: { id: "sub", name: "Inline Skate" }, additionalTeachers: [], ...over });

describe("🔴 the student part of the ONE rule — `studentNamesOf` by value; `displayNameOf` composed of it", () => {
  test("DUO ⇒ `KKTEST & Prao` (the course's stable order, nickname-first per child); Private ⇒ one; studentless ⇒ null; the title never rides in the student part", () => {
    expect(studentNamesOf({ student: KK, coStudent: PRAO })).toBe("KKTEST & Prao");
    expect(studentNamesOf({ student: PRAO, coStudent: KK })).toBe("Prao & KKTEST"); // the order is the row's, on every copy
    expect(studentNamesOf({ student: KK, coStudent: null })).toBe("KKTEST");
    expect(studentNamesOf({ student: PRAO })).toBe("Prao");
    expect(studentNamesOf({ student: null, coStudent: null, otherTitle: "ECA" })).toBeNull();
    expect(displayNameOf({ student: null, otherTitle: "ECA" })).toBe("ECA");
    expect(displayNameOf({ student: KK, coStudent: PRAO })).toBe("KKTEST & Prao");
    expect(code(src("src/db/mappers.ts"))).toContain('export const displayNameOf = (b: any): string => b.otherTitle ?? studentNamesOf(b) ?? "";');
  });
});

describe("🔴 the outbox worker's `bookingContext` by VALUE — the fifth name path, closed", () => {
  test("a DUO row ⇒ `studentName: KKTEST & Prao`; a Private ⇒ one name; an OTHER row ⇒ no studentName (the title rides in `title` → `program`); no row ⇒ {}", async () => {
    let current: any = row();
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => current) as any));
    expect(await bookingContext("b-1")).toMatchObject({ studentName: "KKTEST & Prao", teacherNickname: "Bank", subject: "Inline Skate", date: "2026-10-05", startTime: "10:00", endTime: "11:00" });
    current = row({ coStudent: null });
    expect((await bookingContext("b-1")).studentName).toBe("KKTEST");
    current = row({ bookingType: "OTHER", student: null, coStudent: null, otherTitle: "ECA Club", subject: null });
    const other = await bookingContext("b-1");
    expect(other.studentName).toBeUndefined();
    expect(other.title).toBe("ECA Club");
    current = null;
    expect(await bookingContext("b-1")).toEqual({});
    expect(await bookingContext(null)).toEqual({});
  });
  test("by source: the context loads `coStudent` and names `studentNamesOf`; no `b.student?.name` chain", () => {
    const O = code(src("src/services/outbox.service.ts"));
    const C = region(O, "export async function bookingContext(", "\n}\n");
    expect(C).toContain("with: { student: true, coStudent: true, teacher: true, subject: true, additionalTeachers: { with: { teacher: true } } },");
    expect(C).toContain("studentName: studentNamesOf(b) ?? undefined,");
    expect(C).not.toContain("b.student?.name");
  });
});

describe("🔴 the payload writers and the other booking-row name sites — by source; the CENSUS", () => {
  test("`sendLeaveNotice` reads the co-student beside the student and prints the pair; `confirmCourse` loads `coStudent` on its rows and prints the pair", () => {
    const L = region(SCHED, "async function sendLeaveNotice(", "\n}\n");
    expect(L).toContain("const coStudent = booking.coStudentId");
    expect(L).toContain('studentName: studentNamesOf({ student, coStudent }) ?? "",');
    expect(L).not.toContain("student?.name");
    expect(region(SCHED, "async function loadCourseForEnd(", "\n}\n")).toContain("with: { teacher: true, subject: true, student: true, coStudent: true, rental: true }");
    expect(region(SCHED, "const coursePayload = {", "const notification = confirmed")).toContain("studentName: rows[0] ? studentNamesOf(rows[0]) : null,");
  });
  test("the check-in payload, the ICS feed and the teacher's LINE schedule print the pair too (their reads load `coStudent`)", () => {
    expect(code(src("src/lib/checkin-token.ts"))).toContain('studentName: studentNamesOf(row) ?? "",');
    const CK = code(src("src/services/checkin.service.ts"));
    expect(region(CK, "export async function getCheckinQr(", "\n}\n")).toContain("with: { student: true, coStudent: true },");
    expect(region(CK, "export async function findBookingsForTeacher(", "\n}\n")).toContain("with: { student: true, coStudent: true, subject: true },");
    expect(code(src("src/routes/calendar.ts"))).toContain("studentName: studentNamesOf(b),");
    expect(region(code(src("src/services/calendar.service.ts")), "export async function findBookingsForCalendarToken(", "\n}\n")).toContain("with: { student: true, coStudent: true, subject: true },");
    expect(region(code(src("src/services/line-webhook.service.ts")), "async function doTeacherSchedule(", "\n}\n")).toContain('studentName: studentNamesOf(b) ?? "",');
    expect(formatCheckinPayload({ id: "b", date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", student: KK, coStudent: PRAO }, "tok", "2026-10-05T03:00:00.000Z").studentName).toBe("KKTEST & Prao");
  });
  test("🔴 THE CENSUS — every `studentName:` assignment of a BOOKING row in src goes through `studentNamesOf` / `displayNameOf`; the per-child sites (a group seat, a camp package, a registered student) are the named allow-list", () => {
    const ALLOW = new Set([
      "src/db/mappers.ts:seats", // a GROUP row's seats — one child per seat by construction
      "src/services/jobs.service.ts:seats", // the reminder's seats — same
      "src/services/camp.service.ts", // a camp PACKAGE names its one child
      "src/services/line-register.service.ts", // a registered student (no booking)
      "src/lib/daily-reminder.ts", // carries the job's value (already through the rule)
    ]);
    const bad: string[] = [];
    for (const f of walk("src").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const lines = code(src(f)).split("\n");
      lines.forEach((l, i) => {
        if (!/^\s*studentName:\s/.test(l) && !/[{,]\s*studentName:\s/.test(l)) return;
        if (/studentName:\s*(string|s\.studentName|x\.student|s\.student)/.test(l)) { if (!ALLOW.has(`${f}:seats`) && !ALLOW.has(f) && !/studentName: string/.test(l)) bad.push(`${f}:${i + 1}`); return; }
        if (ALLOW.has(f)) return;
        if (!/studentNamesOf\(|displayNameOf\(/.test(l)) bad.push(`${f}:${i + 1} ${l.trim().slice(0, 80)}`);
      });
    }
    expect(bad).toEqual([]);
  });
});

describe("🔴 the six renderers by VALUE with a DUO context — every `Student :` line prints both names", () => {
  const ctx = { studentName: "KKTEST & Prao", teacherNickname: "Bank", coach: "Bank", subject: "Inline Skate", date: "2026-10-05", startTime: "10:00", endTime: "11:00" };
  const text = (m: string) => m;
  test.each([
    ["booking_confirmed (the confirm)", { kind: "booking_confirmed", bookingId: "b-1", bookingType: "COURSE_PACKAGE", size: 10 }, "parent"],
    ["leave_notice (the leave / make-up)", { kind: "leave_notice", bookingId: "b-1", bookingType: "COURSE_PACKAGE", size: 10, studentName: "KKTEST", via: "line" }, "teacher"],
    ["class_cancelled_parent (the cancel)", { kind: "class_cancelled_parent", bookingId: "b-1", bookingType: "COURSE_PACKAGE", size: 10, cancelReason: "ADMIN_ERROR" }, "parent"],
    ["course_deduction (the deduction)", { kind: "course_deduction", bookingId: "b-1", deductionKind: "course", used: 3, total: 10, remaining: "7/10 HR", expiryDate: "2026-12-31" }, "parent"],
    ["rental_added_teacher (the rental)", { kind: "rental_added_teacher", bookingId: "b-1", bookingType: "COURSE_PACKAGE", size: 10, rental: "Set S" }, "teacher"],
    ["course_confirmed (the course confirm — payload only, no bookingId)", { kind: "course_confirmed", courseId: "c-1", studentName: "KKTEST & Prao", subject: "Inline Skate", size: 10, confirmed: 10, sessions: [] }, "parent"],
  ])("%s", (_n, payload, audience) => {
    const out = text(formatOutboxMessage(payload as any, payload.kind === "course_confirmed" ? {} : ctx, "TH", audience as any));
    expect(out).toContain("KKTEST & Prao");
    expect(out).not.toMatch(/KKTEST(?! & Prao)/); // never the primary alone
  });
});
