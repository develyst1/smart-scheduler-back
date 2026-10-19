// TASK-823 (REQ-125) — a teacher's OWN calendar shows every class they teach, including one where they are an EXTRA teacher (a multi-teacher Other/ECA, a group's extra coach).
// The defect: `getCalendar` fetched those rows (THE predicate `ownScopeWhere` includes extras) but indexed every row under the PRIMARY teacher's id — and a scoped payload has ONE column, the viewer's, so a class
// where the viewer is not the primary was fetched and never drawn. Now a scoped read indexes under the viewer's own column; the unscoped (admin) payload keeps the primary key, byte for byte.
// By value through `getCalendar`, with the database answering what it would for the scoped read (the predicate is the database's; THE predicate itself is pinned in teacher-own-calendar-req097).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as sched from "../services/scheduler.service";
import * as camp from "../services/camp.service";
import { db } from "../db";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const SVC = readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => { const a = s.indexOf(from); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf(to, a + from.length)); };
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const V = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // the viewer (a coach)
const P = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // another coach, the PRIMARY of the co-taught classes
const X = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // a third coach
const D1 = "2026-10-21", D2 = "2026-10-22"; // a Wednesday and a Thursday of one week
const teacher = (id: string, nickname: string) => ({ id, name: nickname, nickname, active: true, type: "FULL_TIME", workDays: [0, 1, 2, 3, 4, 5, 6], teacherSubjects: [], archived: false });
const T = { V: teacher(V, "Vee"), P: teacher(P, "Pim"), X: teacher(X, "Xan") };
const base = { endTime: "11:00:00", student: null, coStudent: null, subject: null, course: null, badges: [], rental: null, seats: [], group: null, groupId: null, courseId: null, campWeekDayId: null, campWeekDay: null, teacherRateMinor: null, pendingSlot: false, status: "CONFIRMED" };
const row = (id: string, date: string, startTime: string, primary: keyof typeof T, extras: Array<keyof typeof T>, type = "OTHER", extra: object = {}) => ({
  ...base, id, date, startTime, bookingType: type, otherKind: type === "GROUP" ? "GROUP" : "ECA", otherTitle: id, teacherId: primary === "V" ? V : primary === "P" ? P : X, teacher: T[primary],
  additionalTeachers: extras.map((e) => ({ teacherId: T[e].id, teacher: T[e], rateMinor: null })), ...extra,
});
// V is the 2nd teacher of a 3-teacher ECA at 10:00 · V's own private lesson at 11:00 · a group whose extra coach is V at 12:00 · (Thursday) V is the FIRST teacher of an ECA at 10:00
const ECA2 = row("eca-v-second", D1, "10:00", "P", ["V", "X"]);
const OWN = row("lesson-v", D1, "11:00", "V", [], "PRIVATE");
const GROUP = row("group-v-extra", D1, "12:00", "P", ["V"], "GROUP");
const ECA1 = row("eca-v-first", D2, "10:00", "V", ["P", "X"]);
const OTHERS = row("not-mine-at-all", D1, "13:00", "P", [], "PRIVATE"); // a class the database would NOT return for V's scoped read (the unscoped read does)

const arm = (bookings: any[]) => {
  spies.push(spyOn(db.query.teachers, "findMany").mockImplementation((async () => [T.V, T.P, T.X]) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.appSettings, "findMany").mockImplementation((async () => []) as any));
  spies.push(spyOn(db.query.boItem, "findMany").mockImplementation((async () => []) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => bookings) as any));
  spies.push(spyOn(sched, "lastLessonDatesForCourses").mockImplementation((async () => new Map()) as any));
  spies.push(spyOn(camp, "weeksForCalendar").mockImplementation((async () => []) as any));
};
const SCOPED = { teacherId: V, isSuperAdmin: false, grants: new Set<string>() } as any;
const ADMIN = { teacherId: null, isSuperAdmin: true, grants: new Set<string>() } as any;
/** `[column teacher nickname, date, time, booking id]` for every filled cell. */
const cells = (cal: any) => cal.days.flatMap((d: any) => d.columns.flatMap((c: any) => c.slots.filter((s: any) => s.booking).map((s: any) => [c.teacher.nickname, d.date, s.time, s.booking.id])));

describe("🔴 a SCOPED calendar draws every class the viewer teaches — as primary OR as an extra teacher", () => {
  test("DAY view: the viewer 2nd of a 3-teacher ECA ⇒ in the viewer's column at its slot; their own lesson ⇒ shown; a group whose extra coach is the viewer ⇒ shown; ONE column", async () => {
    arm([ECA2, OWN, GROUP]);
    const cal: any = await sched.getCalendar({ date: D1, view: "day" }, SCOPED);
    expect(cal.days).toHaveLength(1);
    expect(cal.days[0].columns.map((c: any) => c.teacher.id)).toEqual([V]); // the scoped payload has ONE column, mine
    expect(cells(cal)).toEqual([["Vee", D1, "10:00", "eca-v-second"], ["Vee", D1, "11:00", "lesson-v"], ["Vee", D1, "12:00", "group-v-extra"]]);
  });
  test("the viewer 1st (primary) ⇒ shown, unchanged", async () => {
    arm([ECA1]);
    const cal: any = await sched.getCalendar({ date: D2, view: "day" }, SCOPED);
    expect(cells(cal)).toEqual([["Vee", D2, "10:00", "eca-v-first"]]);
  });
  test("WEEK view: both days' classes land in the viewer's column on their own dates", async () => {
    arm([ECA2, OWN, GROUP, ECA1]);
    const cal: any = await sched.getCalendar({ date: D1, view: "week" }, SCOPED);
    expect(cells(cal)).toEqual([
      ["Vee", D1, "10:00", "eca-v-second"], ["Vee", D1, "11:00", "lesson-v"], ["Vee", D1, "12:00", "group-v-extra"],
      ["Vee", D2, "10:00", "eca-v-first"],
    ]);
    expect(cal.days.every((d: any) => d.columns.length === 1 && d.columns[0].teacher.id === V)).toBe(true);
  });
  test("the ONE-booking-per-cell rule stays: my private lesson and an ECA I co-teach in the SAME slot ⇒ one cell, the first read; a SICK_LEAVE record yields to the active one", async () => {
    const clash = row("eca-same-slot", D1, "11:00", "P", ["V"]);
    arm([OWN, clash]);
    let cal: any = await sched.getCalendar({ date: D1, view: "day" }, SCOPED);
    expect(cells(cal)).toEqual([["Vee", D1, "11:00", "lesson-v"]]);
    spies.splice(0).forEach((s) => s.mockRestore());
    arm([{ ...OWN, status: "SICK_LEAVE" }, clash]);
    cal = await sched.getCalendar({ date: D1, view: "day" }, SCOPED);
    expect(cells(cal)).toEqual([["Vee", D1, "11:00", "eca-same-slot"]]); // the existing preference, untouched
  });
});

describe("🔴 the ADMIN (unscoped) payload is byte-identical — every class stays in its PRIMARY teacher's column, none in the extras'", () => {
  test("the same data, unscoped: ECA2 + GROUP under P, OWN under V, nothing under X; the front places multi-teacher classes into the other columns itself", async () => {
    arm([ECA2, OWN, GROUP, OTHERS]);
    const cal: any = await sched.getCalendar({ date: D1, view: "day" }, ADMIN);
    expect(cal.days[0].columns.map((c: any) => c.teacher.nickname)).toEqual(["Pim", "Vee", "Xan"]);
    expect(cells(cal)).toEqual([["Pim", D1, "10:00", "eca-v-second"], ["Pim", D1, "12:00", "group-v-extra"], ["Pim", D1, "13:00", "not-mine-at-all"], ["Vee", D1, "11:00", "lesson-v"]]);
    // …and the cell itself still lists every assigned teacher (the front's input)
    const eca = cal.days[0].columns.find((c: any) => c.teacher.id === P).slots.find((s: any) => s.time === "10:00").booking;
    expect(eca.teachers.map((t: any) => t.id)).toEqual([P, V, X]);
  });
  test("no viewer at all (null) behaves as the admin", async () => {
    arm([ECA2, OWN]);
    const cal: any = await sched.getCalendar({ date: D1, view: "day" }, null as any);
    expect(cells(cal)).toEqual([["Pim", D1, "10:00", "eca-v-second"], ["Vee", D1, "11:00", "lesson-v"]]);
  });
});

describe("🔑 by source — the key is the scope; the predicate stays the ONE rule for «mine»", () => {
  const CAL = code(region(SVC, "export async function getCalendar(", "export async function getTeachers("));
  test("the cell key is `scope ?? dto.teacher.id` — the viewer's own column when scoped, the primary otherwise", () => {
    expect(CAL).toContain("const key = `${dto.date}|${scope ?? dto.teacher.id}|${dto.startTime}`;");
    expect(CAL).not.toContain("const key = `${dto.date}|${dto.teacher.id}|${dto.startTime}`;");
  });
  test("the scoped read still goes through THE predicate (no second rule for «mine»), and the column filter is unchanged", () => {
    expect(CAL).toContain("scope ? ownScopeWhere(scope) : undefined, // TASK-406");
    expect(CAL).toContain(".filter((t) => !scope || t.id === scope)");
    expect(CAL).toContain("booking: idx.get(`${date}|${teacher.id}|${time}`) ?? null,");
  });
});
