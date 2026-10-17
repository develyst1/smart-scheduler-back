// TASK-815 (REQ-123 Phase 1, P1) — "Generate plan" flags a week that falls on the teacher's advance-leave day. Before: the preview checked leave only while placing make-ups, so a planned
// week on a leave day looked fine and Create then failed 409 TEACHER_ON_LEAVE (TEST-107). Now every drawn week carries `teacherOnLeave: boolean`, from THE reader (`teacherLeaveOn`),
// including a week already ticked as planned absence (the front says "fine", TASK-813). Read-only: the preview still writes nothing. Nothing else in the response changes.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as sched from "../services/scheduler.service";
import { db } from "../db";

const root = resolve(import.meta.dir, "..", "..");
const SVC = readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => { const a = s.indexOf(from); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf(to, a + from.length)); };
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", SUBJ = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

const whereOf = (q: any): Record<string, unknown> => {
  const pairs = [q?.where?.(new Proxy({}, { get: (_t, k) => String(k) }), { and: (...a: any[]) => a.flat(), eq: (c: string, v: unknown) => [[c, v]] })].flat(3);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < pairs.length; i += 2) out[pairs[i] as string] = pairs[i + 1];
  return out;
};
// Course Mon 2026-10-05, size 4: week 1 = 10-05 · 2 = 10-12 · 3 = 10-19 · 4 = 10-26.
const arm = (leave: Array<{ teacherId: string; date: string }>, reads: string[] = []) => {
  setSystemTime(new Date("2026-10-01T10:00:00+07:00")); // every date is today-or-later ⇒ an advance leave FIRES on it
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => ({ id: T1, name: "Bank", nickname: "Bank" })) as any));
  spies.push(spyOn(db.query.subjects, "findFirst").mockImplementation((async () => ({ id: SUBJ, name: "Balance" })) as any));
  spies.push(spyOn(db.query.teacherLeaveDays, "findFirst").mockImplementation((async (q: any) => { const w = whereOf(q); reads.push(`${w.teacherId}|${w.date}`); return leave.find((r) => r.teacherId === w.teacherId && r.date === w.date); }) as any));
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => null) as any));
  // 🚫 the preview writes nothing
  const trip = (w: string) => () => { throw new Error(`TASK-815 tripwire: the preview ${w}`); };
  spies.push(spyOn(db, "insert").mockImplementation(trip("inserted") as any));
  spies.push(spyOn(db, "update").mockImplementation(trip("updated") as any));
  spies.push(spyOn(db, "delete").mockImplementation(trip("deleted") as any));
  spies.push(spyOn(db, "transaction").mockImplementation(trip("opened a transaction") as any));
};
const input = (absentWeeks?: number[]) => ({ teacherId: T1, subjectId: SUBJ, size: 4, startDate: "2026-10-05", startTime: "10:00", ...(absentWeeks ? { absentWeeks } : {}) });
const flags = (out: any) => out.sessions.map((s: any) => [s.date, s.teacherOnLeave]);

describe("🔴 TASK-815 — each drawn week says whether the teacher is on advance leave that day", () => {
  test("a planned week on a leave day is flagged `teacherOnLeave: true`; the others false — and the rest of the row is unchanged", async () => {
    arm([{ teacherId: T1, date: "2026-10-19" }]);
    const out: any = await sched.previewCoursePackage(input());
    expect(flags(out)).toEqual([["2026-10-05", false], ["2026-10-12", false], ["2026-10-19", true], ["2026-10-26", false]]);
    expect(out.sessions[2]).toEqual({ date: "2026-10-19", startTime: "10:00", teacher: { id: T1, name: "Bank", nickname: "Bank" }, subject: { id: SUBJ, name: "Balance" }, absent: false, makeup: false, teacherOnLeave: true });
  });
  test("no leave recorded ⇒ every week false (today's behaviour, plus the field)", async () => {
    arm([]);
    const out: any = await sched.previewCoursePackage(input());
    expect(out.sessions.every((s: any) => s.teacherOnLeave === false)).toBe(true);
    expect(out.sessions).toHaveLength(4);
  });
  test("a week ALREADY ticked as planned absence still carries the flag (the front can say «this absence is on the leave day: fine»)", async () => {
    arm([{ teacherId: T1, date: "2026-10-19" }]);
    const out: any = await sched.previewCoursePackage(input([3]));
    const w3 = out.sessions[2];
    expect([w3.date, w3.absent, w3.teacherOnLeave]).toEqual(["2026-10-19", true, true]);
    // the appended make-up SKIPS the leave day (TASK-561 Seam B) and so is not on it
    const makeup = out.sessions.find((s: any) => s.makeup);
    expect(makeup.date).toBe("2026-11-02");
    expect(makeup.teacherOnLeave).toBe(false);
  });
  test("another teacher's leave on that day does not flag this teacher's week", async () => {
    arm([{ teacherId: "someone-else", date: "2026-10-19" }]);
    const out: any = await sched.previewCoursePackage(input());
    expect(out.sessions.every((s: any) => s.teacherOnLeave === false)).toBe(true);
  });
  test("a leave day in the PAST (the block fires only today-or-later) does not flag — the reader's own rule, not a second one", async () => {
    arm([{ teacherId: T1, date: "2026-10-12" }]);
    setSystemTime(new Date("2026-10-15T10:00:00+07:00")); // 10-12 is now history; 10-19 is still ahead
    const out: any = await sched.previewCoursePackage(input());
    expect(flags(out).find(([d]: any) => d === "2026-10-12")![1]).toBe(false);
  });
  test("the answer asks THE reader: one read per drawn week, by teacher+date, and the preview writes nothing", async () => {
    const reads: string[] = [];
    arm([{ teacherId: T1, date: "2026-10-19" }], reads);
    await sched.previewCoursePackage(input());
    for (const d of ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]) expect(reads).toContain(`${T1}|${d}`);
  });
  test("the rest of the response is unchanged (size · dates · absentWeeks · liveCount · endDate · exceedsCeiling)", async () => {
    arm([{ teacherId: T1, date: "2026-10-19" }]);
    const out: any = await sched.previewCoursePackage(input());
    expect(Object.keys(out).sort()).toEqual(["absentWeeks", "endDate", "exceedsCeiling", "expiryDate", "liveCount", "sessions", "size", "startDate", "startTime"]);
    expect(out).toMatchObject({ size: 4, startDate: "2026-10-05", startTime: "10:00", absentWeeks: [], liveCount: 4, endDate: "2026-10-26", exceedsCeiling: false });
  });
});

describe("TASK-815 — by source: the ONE reader, no second date check, claim kept", () => {
  const PREVIEW = code(region(SVC, "export async function previewCoursePackage(", "\n}\n"));
  test("the flag comes from `teacherLeaveOn` over the drawn weeks, and the response carries the flagged list", () => {
    expect(PREVIEW).toContain("const onLeave = await Promise.all(sessions.map((s) => teacherLeaveOn(db, input.teacherId, s.date)));");
    expect(PREVIEW).toContain("const flagged = sessions.map((s, i) => ({ ...s, teacherOnLeave: onLeave[i] != null }));");
    expect(PREVIEW).toContain("sessions: flagged,");
    expect(PREVIEW).not.toMatch(/teacherLeaveDays|new Date\(|Date\.parse|bangkokNow/);
  });
  test("the contract names the field on the drawn week", () => {
    const C = code(readFileSync(resolve(root, "src/types/contract.ts"), "utf8").replace(/\r\n/g, "\n"));
    expect(C).toContain("export interface CoursePreviewSessionDTO {");
    expect(region(C, "export interface CoursePreviewSessionDTO {", "\n}\n")).toContain("  teacherOnLeave: boolean;");
  });
});
