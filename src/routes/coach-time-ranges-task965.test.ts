// TASK-965 (REQ-5015, SPEC-108 §4) — the ROOT app: the routes take the new optional fields, refuse the malformed ones with the generic 400 VALIDATION before any service runs,
// and hand the services exactly what they were given. A whole-day body reaches the service byte-for-byte as before (AC4).
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import * as sched from "../services/scheduler.service";
import * as systemTeacher from "../lib/system-teacher";
import { DEV_USER } from "../middleware/auth";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret-task965"; // hermetic: a test value, never a real one
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); delete process.env.SKIP_AUTH; });
const NOW = "2026-11-13T10:00:00+07:00";
const T = "11111111-1111-4111-8111-111111111111";
const rootApp = async () => (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const call = async (method: string, path: string, body?: unknown) => {
  process.env.SKIP_AUTH = "true";
  const app = await rootApp();
  const res = await app.fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};

describe("POST /api/teacher-leave-days — the part-day window", () => {
  const arm = () => {
    const seen: any[] = [];
    spies.push(spyOn(systemTeacher, "assertTeacherMayHaveLeave").mockImplementation((async () => {}) as any));
    spies.push(spyOn(sched, "reportTeacherLeave").mockImplementation((async (teacherId: string, input: any, actor: any) => { seen.push([teacherId, input, actor]); return { mode: "advance", leave: { date: input.date, reason: input.reason, ...(input.startTime ? { startTime: input.startTime, endTime: input.endTime } : {}) }, bookings: [] }; }) as any));
    setSystemTime(new Date(NOW));
    return seen;
  };
  const body = { teacherId: T, reason: "ธุระ", date: "2026-11-20" };
  test("a 10–12 body reaches the act with the window; the answer carries it", async () => {
    const seen = arm();
    const r = await call("POST", "/teacher-leave-days", { ...body, startTime: "10:00", endTime: "12:00" });
    expect(r.status).toBe(200);
    expect(r.body.leave).toEqual({ date: "2026-11-20", reason: "ธุระ", startTime: "10:00", endTime: "12:00" });
    expect(seen).toEqual([[T, { date: "2026-11-20", reason: "ธุระ", startTime: "10:00", endTime: "12:00" }, DEV_USER.username]]);
  });
  test("a WHOLE-day body reaches the act exactly as before: no time keys at all", async () => {
    const seen = arm();
    const r = await call("POST", "/teacher-leave-days", body);
    expect(r.status).toBe(200);
    expect(seen[0][1]).toEqual({ date: "2026-11-20", reason: "ธุระ" });
  });
  test("a RANGE with a window reaches the act with it", async () => {
    const seen = arm();
    const r = await call("POST", "/teacher-leave-days", { teacherId: T, reason: "ธุระ", from: "2026-11-20", to: "2026-11-22", startTime: "13:00", endTime: "17:30" });
    expect(r.status).toBe(200);
    expect(seen[0][1]).toEqual({ date: "2026-11-20", to: "2026-11-22", reason: "ธุระ", startTime: "13:00", endTime: "17:30" });
  });
  test("every malformed window is a 400 VALIDATION and the act NEVER runs", async () => {
    const seen = arm();
    const sid = "22222222-2222-4222-8222-222222222222";
    const bad = [
      { ...body, startTime: "10:00" }, // one without the other
      { ...body, endTime: "12:00" },
      { ...body, startTime: "12:00", endTime: "10:00" }, // start after end
      { ...body, startTime: "10:00", endTime: "10:00" },
      { ...body, startTime: "10:15", endTime: "12:00" }, // not on the hour / half hour
      { ...body, startTime: "10:00", endTime: "12:00", sessionIds: [sid] }, // a window with picked classes
      { teacherId: T, reason: "ธุระ", from: "2026-11-20", to: "2026-11-22", startTime: "10:00" }, // a range with one side
    ];
    for (const b of bad) {
      const r = await call("POST", "/teacher-leave-days", b);
      expect({ b, status: r.status, code: r.body?.error?.code }).toEqual({ b, status: 400, code: "VALIDATION" });
    }
    expect(seen).toEqual([]);
  });
});

describe("PATCH /api/teachers/:id/work-days and its impact preview — the working hours", () => {
  test("a body with `workHours` reaches the service (null clears, absent = unchanged); the answer is the teacher DTO", async () => {
    const seen: any[] = [];
    spies.push(spyOn(sched, "setTeacherWorkDays").mockImplementation((async (...a: any[]) => { seen.push(a); return { id: a[0], workDays: a[1], workHours: a[2] ?? null }; }) as any));
    const hours = { "6": ["13:00", "18:00"] };
    expect((await call("PATCH", `/teachers/${T}/work-days`, { workDays: [6], workHours: hours })).body).toMatchObject({ workDays: [6], workHours: hours });
    await call("PATCH", `/teachers/${T}/work-days`, { workDays: [6], workHours: null });
    await call("PATCH", `/teachers/${T}/work-days`, { workDays: [6] });
    expect(seen).toEqual([[T, [6], hours], [T, [6], null], [T, [6], undefined]]);
  });
  test("a window on a day the coach does not work, or from ≥ to, or off the half hour, is 400 VALIDATION and nothing is saved", async () => {
    const seen: any[] = [];
    spies.push(spyOn(sched, "setTeacherWorkDays").mockImplementation((async (...a: any[]) => { seen.push(a); return {}; }) as any));
    for (const b of [{ workDays: [0], workHours: { "6": ["13:00", "18:00"] } }, { workDays: [6], workHours: { "6": ["18:00", "13:00"] } }, { workDays: [6], workHours: { "6": ["13:10", "18:00"] } }]) {
      const r = await call("PATCH", `/teachers/${T}/work-days`, b);
      expect({ status: r.status, code: r.body?.error?.code }).toEqual({ status: 400, code: "VALIDATION" });
    }
    expect(seen).toEqual([]);
  });
  test("the impact preview: `workHours` (JSON) reaches the service; without it the call is today's (the third argument is undefined)", async () => {
    const seen: any[] = [];
    spies.push(spyOn(sched, "previewWorkDaysChange").mockImplementation((async (...a: any[]) => { seen.push(a); return { removedDays: [], removedDaysLabel: "", orphanCount: 0, sessions: [] }; }) as any));
    const hours = { "6": ["13:00", "18:00"] };
    await call("GET", `/teachers/${T}/work-days/impact?workDays=0,6&workHours=${encodeURIComponent(JSON.stringify(hours))}`);
    await call("GET", `/teachers/${T}/work-days/impact?workDays=0,6`);
    expect(seen).toEqual([[T, [0, 6], hours], [T, [0, 6], undefined]]);
    const bad = await call("GET", `/teachers/${T}/work-days/impact?workDays=0,6&workHours=${encodeURIComponent("{nope")}`);
    expect(bad.status).toBe(400);
    expect(seen).toHaveLength(2);
  });
});

describe("POST /api/teachers — the working hours at creation (SPEC-108 §4a)", () => {
  const base = { name: "Ek Coach", nickname: "Ek", type: "FULL_TIME" };
  test("`workHours` reaches the service (keys among `workDays`); without it the body is today's; the answer is 201", async () => {
    const seen: any[] = [];
    spies.push(spyOn(sched, "createTeacher").mockImplementation((async (input: any) => { seen.push(input); return { id: T, ...input }; }) as any));
    const hours = { "6": ["13:00", "18:00"] };
    expect((await call("POST", "/teachers", { ...base, workDays: [6], workHours: hours })).status).toBe(201);
    expect((await call("POST", "/teachers", { ...base, workHours: hours })).status).toBe(201); // no workDays = every weekday
    expect((await call("POST", "/teachers", base)).status).toBe(201);
    expect(seen.map((i) => i.workHours)).toEqual([hours, hours, undefined]);
  });
  test("a window on a day the new coach does not work, from ≥ to, or off the half hour: 400 VALIDATION, nothing created", async () => {
    const seen: any[] = [];
    spies.push(spyOn(sched, "createTeacher").mockImplementation((async (input: any) => { seen.push(input); return {}; }) as any));
    for (const b of [{ ...base, workDays: [0], workHours: { "6": ["13:00", "18:00"] } }, { ...base, workHours: { "6": ["18:00", "13:00"] } }, { ...base, workHours: { "6": ["13:10", "18:00"] } }]) {
      const r = await call("POST", "/teachers", b);
      expect({ status: r.status, code: r.body?.error?.code }).toEqual({ status: 400, code: "VALIDATION" });
    }
    expect(seen).toEqual([]);
  });
});
