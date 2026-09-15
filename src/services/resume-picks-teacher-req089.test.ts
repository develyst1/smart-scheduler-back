// TASK-359 (`REQ-089 item 8`) — pick the teacher on resume, BOTH doors (dropped course · paused booking).
// Owner: *"เลือกครูตอนกลับมาเรียนทั้งคอร์สที่ดร็อปไว้และ pause booking"* — the teacher is fixed today; on resume the admin picks.
//
// 🔑 One optional field on each body. ABSENT ⇒ today, byte for byte. PRESENT ⇒ that teacher on every row the
// resume writes, the create path's OWN guard on the chosen one, and the clash naming THEM.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import * as v from "../validation";

const read = async (rel: string) => readSrc(await Bun.file(new URL(rel, import.meta.url)).text());
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(await read("./scheduler.service.ts"));
const fn = (sig: string) => { const i = SVC.indexOf(sig); if (i < 0) throw new Error("no " + sig); return SVC.slice(i, SVC.indexOf("\n}\n", i) + 2); };
const RESUME_BOOKING = fn("export async function resumeBooking(");
const RESUME_COURSE = fn("export async function resumeCourse(");
const T1 = "11111111-1111-4111-8111-111111111111";

describe("📜 the contract — one OPTIONAL field on each body, nothing else moved", () => {
  test("both validators accept `teacherId?` as a UUID, and refuse a non-UUID", () => {
    expect(v.resumeBooking.safeParse({ date: "2026-09-16", startTime: "10:00" }).success).toBe(true);
    expect(v.resumeBooking.safeParse({ date: "2026-09-16", startTime: "10:00", teacherId: T1 }).success).toBe(true);
    expect(v.resumeBooking.safeParse({ date: "2026-09-16", startTime: "10:00", teacherId: "ครูเอ" }).success).toBe(false);
    expect(v.resumeCourse.safeParse({ startDate: "2026-09-16", startTime: "10:00" }).success).toBe(true);
    expect(v.resumeCourse.safeParse({ startDate: "2026-09-16", startTime: "10:00", teacherId: T1 }).success).toBe(true);
    expect(v.resumeCourse.safeParse({ startDate: "2026-09-16", startTime: "10:00", teacherId: "x" }).success).toBe(false);
  });

  test("🚫 …and ABSENT parses to exactly the old body — no default is injected", () => {
    expect(v.resumeBooking.parse({ date: "2026-09-16", startTime: "10:00" })).toEqual({ date: "2026-09-16", startTime: "10:00" });
    expect(v.resumeCourse.parse({ startDate: "2026-09-16", startTime: "10:00" })).toEqual({ startDate: "2026-09-16", startTime: "10:00" });
  });
});

describe("🔴 the paused BOOKING — absent ⇒ its own teacher; present ⇒ the chosen one, everywhere the resume writes", () => {
  test("🔑 the ONE derivation, and the row is written with it", () => {
    expect(RESUME_BOOKING).toContain("const teacherId = input.teacherId ?? current.teacherId;");
    const set = RESUME_BOOKING.slice(RESUME_BOOKING.indexOf(".set({"), RESUME_BOOKING.indexOf("})", RESUME_BOOKING.indexOf(".set({")));
    expect(set).toContain("teacherId,");
    // ⚠️ the absent case is the SAME expression: with no pick, `teacherId` IS `current.teacherId` — the old write.
    expect(RESUME_BOOKING).not.toContain("teacherId: current.teacherId");
  });

  test("🔑 the clash names the CHOSEN teacher, through the one clash describer", () => {
    expect(RESUME_BOOKING).toContain("describeSlotClash(teacherId, input.date, input.startTime)");
    expect(RESUME_BOOKING).not.toContain("describeSlotClash(current.teacherId");
    expect((RESUME_BOOKING.match(/describeSlotClash\(/g) ?? []).length).toBe(1);
  });

  test("🔑 a PICKED teacher goes through the CREATE path's own guard — `assertTeacherBookable`, one source", () => {
    // exists · not archived · works that weekday · freelance budget — the guard `insertBooking` runs on every
    // create. Only when a teacher was actually picked and it differs: the absent path runs nothing new.
    expect(RESUME_BOOKING).toContain("if (input.teacherId && input.teacherId !== current.teacherId) await assertTeacherBookable(tx, input.teacherId, input.date);");
    expect(RESUME_BOOKING.indexOf("assertTeacherBookable(")).toBeLessThan(RESUME_BOOKING.indexOf(".update(bookings)"));
    // 🚫 no second guard, no second message shape: the resume invents nothing.
    expect(RESUME_BOOKING).not.toContain("ไม่พบครู");
    expect(RESUME_BOOKING).not.toContain("teacherSubjects");
  });

  test("📌 the EXISTING `booking_resumed` send reads the row AFTER the update — so it follows the row's teacher; nothing was added", () => {
    const send = RESUME_BOOKING.indexOf('payload: { kind: "booking_resumed" }');
    const update = RESUME_BOOKING.indexOf(".update(bookings)");
    expect(update).toBeLessThan(send);
    expect(RESUME_BOOKING).toContain("with: { teacher: true },");
    expect((RESUME_BOOKING.match(/enqueueLine\(/g) ?? []).length).toBe(1); // still exactly one send
  });
});

describe("🔴 the dropped COURSE — absent ⇒ the LAST session's teacher (TASK-361); present ⇒ the chosen one on every re-planned session", () => {
  test("🔑 the ONE derivation, and every `insertBooking` in the loop uses it", () => {
    // 🔻 TASK-361 — the OWNER ruled on TASK-359's finding 2: the absent default is `rows.at(-1)`, the teacher the
    // family LAST had, not `rows[0]`, the course's earliest session (a reassigned-then-dropped course used to be
    // handed BACK to its original teacher). One line; the absent path moved on purpose.
    expect(RESUME_COURSE).toContain("const teacherId = input.teacherId ?? rows.at(-1)?.teacherId ?? null;");
    expect(RESUME_COURSE).not.toContain("rows[0]?.teacherId");
    const loop = RESUME_COURSE.slice(RESUME_COURSE.indexOf("for (const date of dates) {"));
    expect(loop).toContain("await insertBooking(tx, studentId, {\n          teacherId,");
    expect((loop.match(/teacherId/g) ?? []).length).toBe(1); // no per-session override, no second source
  });

  test("🔑 …and `insertBooking` runs `assertTeacherBookable` per session — the create path's guard, per created row", () => {
    const insert = fn("async function insertBooking(");
    expect(insert).toContain("await assertTeacherBookable(exec, input.teacherId, input.date);");
    // 🚫 the course resume adds no guard of its own: the guard it gets is the one every create gets.
    expect(RESUME_COURSE).not.toContain("assertTeacherBookable(");
  });

  test("📌 `rows` is ordered `asc(date), asc(startTime)` — so `rows.at(-1)` is the LAST session, the one the family last had", () => {
    const load = fn("async function loadCourseForEnd(");
    expect(load).toContain("orderBy: (b: any, { asc }: any) => [asc(b.date), asc(b.startTime)],");
    expect(RESUME_COURSE).toContain("const { course, rows } = await loadCourseForEnd(tx, id);");
  });

  test("🚫 the course resume sends nothing — and still sends nothing", () => {
    expect(RESUME_COURSE).not.toContain("enqueueLine(");
  });
});

describe("🔴 THE FINDING — there is no server-side teacher↔subject rule on the CREATE path, so none is invented here", () => {
  test("`insertBooking`'s only teacher guard is `assertTeacherBookable`; `teacher_subjects` is read for LISTS, never for a refusal", () => {
    const insert = fn("async function insertBooking(");
    expect(insert).not.toContain("teacherSubjects");
    const guard = fn("async function assertTeacherBookable(");
    expect(guard).not.toContain("subject");
    // every `teacherSubjects` read in the service is a `with:` (a list join) or the teacher editor's own writes.
    for (const m of SVC.matchAll(/teacherSubjects/g)) {
      const line = SVC.slice(SVC.lastIndexOf("\n", m.index) + 1, SVC.indexOf("\n", m.index));
      expect({ line: line.trim().slice(0, 60), listOrEditor: /with:|\.insert\(teacherSubjects\)|\.delete\(teacherSubjects\)|query\.teacherSubjects|^import/.test(line) }).toEqual({ line: line.trim().slice(0, 60), listOrEditor: true });
    }
    // 🚫 …and neither resume door grew one: a rule the create door does not have is a second source.
    expect(RESUME_BOOKING).not.toContain("subject");
    expect(RESUME_COURSE).not.toMatch(/teacherSubjects|does not teach|ไม่ได้สอน/);
  });

  test("❓ neither resume message prints the teacher — so there is no output to change, and none was", async () => {
    const I18N = await read("../lib/line-i18n.ts");
    const resumed = I18N.slice(I18N.indexOf("ob_resumed: {"), I18N.indexOf("},", I18N.indexOf("ob_resumed: {")));
    expect(resumed).toContain("{student} · {date} {time}");
    expect(resumed).not.toContain("{teacher}");
  });
});
