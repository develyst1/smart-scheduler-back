// 🔻 TASK-986 (TEST-163, F-081) — a class starts only on a whole hour 09:00–17:00 (a calendar hour: `TIME_SLOTS`), on EVERY door that sets a class's start time; or it is saved and never drawn.
// Each schema is probed on its start-time path: the base parse reports the Thai sentence for 18:00 / 08:00 / 10:30 and nothing for 09:00 / 17:00 (other fields are left out on purpose — only issues AT that path are read).
import { describe, expect, test } from "bun:test";
import * as v from "./validation";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.SKIP_AUTH = "true";

const MSG = "เวลาเริ่มคลาสต้องเป็นชั่วโมงเต็ม 09:00–17:00";
const DATE = "2026-12-01";

type Issue = { path: (string | number)[]; message: string; unionErrors?: { issues: Issue[] }[] };
const flat = (issues: Issue[]): Issue[] => issues.flatMap((i) => [i, ...flat((i.unionErrors ?? []).flatMap((u) => u.issues))]);
const atPath = (schema: { safeParse: (x: unknown) => any }, body: unknown, path: (string | number)[]) => {
  const r = schema.safeParse(body);
  if (r.success) return [] as Issue[];
  return flat(r.error.issues as Issue[]).filter((i) => i.path.join(".") === path.join("."));
};

// [name, schema, body-with-this-time, issue path]
const DOORS: Array<[string, any, (t: string) => unknown, (string | number)[]]> = [
  ["createBooking", v.createBooking, (t) => ({ date: DATE, startTime: t }), ["startTime"]],
  ["patternSlot", v.patternSlot, (t) => ({ weekday: 1, startTime: t }), ["startTime"]],
  ["createCoursePackage", v.createCoursePackage, (t) => ({ startDate: DATE, startTime: t }), ["startTime"]],
  ["createCoursePackage (sessions[])", v.createCoursePackage, (t) => ({ sessions: [{ date: DATE, startTime: t }] }), ["sessions", 0, "startTime"]],
  ["previewCourse", v.previewCourse, (t) => ({ startDate: DATE, startTime: t }), ["startTime"]],
  ["groupSeries", v.groupSeries, (t) => ({ startTime: t, dates: [DATE] }), ["startTime"]],
  ["resolveClashMove", v.resolveClashMove, (t) => ({ startTime: t }), ["startTime"]],
  ["otherSeries", v.otherSeries, (t) => ({ startTime: t, dates: [DATE] }), ["startTime"]],
  ["moveBooking", v.moveBooking, (t) => ({ startTime: t }), ["startTime"]],
  ["planChange (insert)", v.planChange, (t) => ({ kind: "insert", date: DATE, startTime: t }), ["startTime"]],
  ["planChange (move)", v.planChange, (t) => ({ kind: "move", bookingId: "x", startTime: t }), ["startTime"]],
  ["importCoursePackage", v.importCoursePackage, (t) => ({ startDate: DATE, startTime: t }), ["startTime"]],
  ["extraSession", v.extraSession, (t) => ({ date: DATE, startTime: t }), ["startTime"]],
  ["resumeBooking", v.resumeBooking, (t) => ({ date: DATE, startTime: t }), ["startTime"]],
  ["changeCourseTeacherTime", v.changeCourseTeacherTime, (t) => ({ startDate: DATE, startTime: t }), ["startTime"]],
  ["resumeCourse", v.resumeCourse, (t) => ({ startDate: DATE, startTime: t }), ["startTime"]],
];

describe("🔴 TASK-986 — a class start is a whole hour 09:00–17:00 on every door", () => {
  for (const [name, schema, body, path] of DOORS) {
    test(`${name}: 18:00, 08:00 and 10:30 are refused with the Thai sentence`, () => {
      for (const t of ["18:00", "08:00", "10:30"]) {
        const issues = atPath(schema, body(t), path);
        expect({ t, messages: issues.map((i) => i.message) }).toEqual({ t, messages: [MSG] });
      }
    });
    test(`${name}: 09:00 and 17:00 raise no issue on the start time`, () => {
      for (const t of ["09:00", "17:00"]) expect({ t, issues: atPath(schema, body(t), path) }).toEqual({ t, issues: [] });
    });
  }
  test("a malformed time still gets the format sentence (CLASS_TIME is TIME plus the hour rule)", () => {
    expect(atPath(v.extraSession, { date: DATE, startTime: "9am" }, ["startTime"]).map((i) => i.message)).toContain("ต้องเป็นรูปแบบ HH:mm");
  });
});

describe("🔒 TASK-986 — what stays half-hour on purpose (REQ-5015)", () => {
  test("a part-day leave window still accepts 10:30", () => {
    expect(atPath(v.adminTeacherLeaveBody, { startTime: "10:30", endTime: "12:30" }, ["startTime"])).toEqual([]);
    expect(atPath(v.adminTeacherLeaveBody, { startTime: "10:30", endTime: "12:30" }, ["endTime"])).toEqual([]);
  });
  test("the coach's working hours still accept 08:30 and 18:30", () => {
    const r = (v as any).setTeacherWorkDays?.safeParse({ workDays: [1], workHours: { "1": ["08:30", "18:30"] } });
    expect(r === undefined || r.success).toBe(true);
  });
  test("by source: `TIME` remains on exactly the leave window, the working hours and the availability READ", () => {
    const src = require("node:fs").readFileSync(new URL("./validation.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const code = src.split("\n").filter((l: string) => !l.trim().startsWith("//")).join("\n");
    expect((code.match(/startTime: TIME\b/g) ?? []).length).toBe(2); // slotAvailabilityQuery + adminTeacherLeaveBody
    expect((code.match(/startTime: CLASS_TIME\b/g) ?? []).length).toBe(16); // the 16 class-start fields
    expect(code).toContain("z.tuple([TIME, TIME])");
  });
});

describe("🔒 TASK-986 — through the validation envelope", () => {
  test("POST /bookings at 18:00 → 400 VALIDATION, the Thai sentence in `details`", async () => {
    const { api } = await import("./routes/api");
    const res = await api.request("/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: DATE, startTime: "18:00" }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("VALIDATION");
    expect(JSON.stringify(body.error.details)).toContain(MSG);
  });
});
