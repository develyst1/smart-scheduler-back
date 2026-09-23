// TASK-434 (`REQ-102 §8`) — key 59 on EVERY coach-rate surface: the Stage-1 ECA/Group per-teacher rates join the mask
// (`teacherRates` ⇒ null on the booking DTO's `other`, the group DTO, the series DTOs) and the write check (every writer
// carrying `teacherRates` / `rateMinor` / `classRateMinor` / `duo.classRateMinor` ⇒ 403 without the key; `duo` alone no
// longer trips it); the rate is OPTIONAL at the DUO create (a user without key 59 creates the DUO, a key holder sets the
// default later). The TASK-431 scan pin is extended to the full key set. 57 ⇄ 59 stay independent. No migration.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { COACH_RATE_BODY_FIELDS, COACH_RATE_KEY, COACH_RATE_KEYS, bodyEditsCoachRate, maskCoachRate } from "./coach-rate-visibility";
import { effectiveRateMinor, rateFacts } from "./coach-rate";
import { ACTION_KEYS, MENU_KEYS } from "./permissions";
import * as v from "../validation";
import * as sched from "../services/scheduler.service";
import * as series from "../services/other-series.service";
import { toBookingDTO } from "../db/mappers";
import { DEV_USER } from "../middleware/auth";
import { db } from "../db";
import { readSrc } from "./read-src";
import { uuidFor } from "./test-uuid";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const walk = (d: string): string[] => readdirSync(resolve(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const json = (method: string, path: string, body?: unknown) =>
  rootApp.fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", T2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", SUBJ = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", K = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const spies: Array<{ mockRestore: () => void }> = [];
const savedUser = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
const setUser = (u: { isSuperAdmin: boolean; grants?: Iterable<string>; teacherId?: string | null }) => {
  (DEV_USER as any).isSuperAdmin = u.isSuperAdmin; (DEV_USER as any).grants = new Set(u.grants ?? []); (DEV_USER as any).teacherId = u.teacherId ?? null;
};
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, savedUser); });
const SUPER = { isSuperAdmin: true, grants: new Set<string>() };
const STAFF_NO59 = { isSuperAdmin: false, grants: new Set<string>([...MENU_KEYS, ...ACTION_KEYS.filter((k) => k !== COACH_RATE_KEY)]) };
const otherRow = { id: "o1", date: "2026-10-05", startTime: "15:00:00", endTime: "16:00:00", bookingType: "OTHER", status: "PENDING", otherTitle: "ECA Club", otherKind: "ECA", headCount: 12, teacherId: T1, teacherRateMinor: 50000, teacher: { id: T1, name: "Bank", nickname: "Bank" }, student: null, badges: [], additionalTeachers: [{ teacherId: T2, rateMinor: 40000, teacher: { id: T2, name: "Nok", nickname: "Nok" } }], seats: [], group: null, campWeekDay: null, rental: null };

describe("🔴 the CENSUS — every producer of a per-teacher rate is a key the mask names; nothing else in src produces one", () => {
  test("the producers: `other.teacherRates` (otherFacts), `group.teacherRates` (groupFacts), the series DTOs' `teacherRates`; NO DTO carries `rateMinor` (the extras' rate is folded into `teacherRates`)", () => {
    expect([...COACH_RATE_KEYS]).toEqual(["rate", "classRateMinor", "teacherRates"]);
    const producers = walk("src").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("coach-rate-visibility")).filter((f) => {
      const c = code(src(f));
      return /^\s*rate:\s/m.test(c) || /^\s*classRateMinor:\s(?!z\.|input|integer\()/m.test(c) || /^\s*teacherRates:\s(?!z\.|Record|input|rates,)/m.test(c) || /(^|[{,]\s*)teacherRates: (ratesOf|o\.teacherRates)/m.test(c);
    }).sort();
    expect(producers).toEqual(["src/db/mappers.ts", "src/services/other-series.service.ts"]);
    // no response key `rateMinor` anywhere (the booking DTO's `teachers[]` is `toTeacherBase` — id · name · nickname · type)
    const rateMinorProducers = walk("src").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).filter((f) => /^\s*rateMinor:\s(?!z\.|integer\(|number|input\.|rates\[|r\.rateMinor|it\.)/m.test(code(src(f))));
    expect(rateMinorProducers).toEqual([]);
    expect(code(src("src/db/mappers.ts"))).toContain("export const toTeacherBase = (t: any) => ({");
    expect(code(src("src/db/mappers.ts")).slice(0, 2000)).not.toMatch(/rateMinor/);
  });
  test("the mask by value on the three surfaces: an OTHER row's `other.teacherRates`, a GROUP row's `group.teacherRates`, a series DTO's `teacherRates` ⇒ null; `hourlyRate` (57) untouched", () => {
    const o: any = maskCoachRate(toBookingDTO(otherRow));
    expect(o.other).toEqual({ kind: "ECA", headCount: 12, teacherRates: null, ratePostedAt: null });
    expect((toBookingDTO(otherRow) as any).other.teacherRates).toEqual({ [T1]: 50000, [T2]: 40000 }); // the unmasked truth
    const g: any = maskCoachRate(toBookingDTO({ ...otherRow, bookingType: "GROUP", otherKind: "GROUP", groupKey: K, headCount: 6 }));
    expect(g.group.teacherRates).toBeNull();
    expect(g.group.kind).toBe("GROUP");
    const s = maskCoachRate({ key: K, teacherRates: { [T1]: 50000 }, rows: [{ bookingId: "x" }], teacher: { hourlyRate: 500 } });
    expect(s as any).toEqual({ key: K, teacherRates: null, rows: [{ bookingId: "x" }], teacher: { hourlyRate: 500 } });
  });
  test("by value through the ROOT app: `GET /bookings` (an OTHER row) and `GET /other-series/:key` read `teacherRates: null` without 59, intact with", async () => {
    process.env.SKIP_AUTH = "true";
    spies.push(spyOn(sched, "getBookings").mockImplementation((async () => ({ items: [toBookingDTO(otherRow)], page: 1, limit: 50, total: 1 })) as any));
    spies.push(spyOn(series, "getOtherSeries").mockImplementation((async () => ({ key: K, title: "ECA Club", kind: "ECA", headCount: 12, startTime: "15:00", teacherId: T1, additionalTeacherIds: [T2], teacherRates: { [T1]: 50000, [T2]: 40000 }, rows: [] })) as any));
    setUser(STAFF_NO59);
    expect(((await (await json("GET", "/bookings")).json()) as any).items[0].other.teacherRates).toBeNull();
    expect(((await (await json("GET", `/other-series/${K}`)).json()) as any).teacherRates).toBeNull();
    setUser(SUPER);
    expect(((await (await json("GET", "/bookings")).json()) as any).items[0].other.teacherRates).toEqual({ [T1]: 50000, [T2]: 40000 });
    expect(((await (await json("GET", `/other-series/${K}`)).json()) as any).teacherRates).toEqual({ [T1]: 50000, [T2]: 40000 });
  });
});

describe("🔴 the WRITE half on every rate-carrying writer — 403 with a rate field, 200 without; `duo` alone passes; the rate optional at the DUO create", () => {
  test("`bodyEditsCoachRate`: the three body fields (any value) and `duo.classRateMinor`; `duo` without a rate, a plain edit ⇒ not an edit", () => {
    expect([...COACH_RATE_BODY_FIELDS]).toEqual(["classRateMinor", "teacherRates", "rateMinor"]);
    expect(bodyEditsCoachRate({ teacherRates: {} })).toBe(true);
    expect(bodyEditsCoachRate({ rateMinor: 0 })).toBe(true);
    expect(bodyEditsCoachRate({ classRateMinor: null })).toBe(true);
    expect(bodyEditsCoachRate({ duo: { coStudentId: B, classRateMinor: 1 } })).toBe(true);
    expect(bodyEditsCoachRate({ duo: { coStudentId: B } })).toBe(false); // 🔻 TASK-434: the create without a rate
    expect(bodyEditsCoachRate({ otherKind: "FREE", headCount: 3 })).toBe(false);
    expect(bodyEditsCoachRate({ teacherId: T2, fromDate: "2026-10-12" })).toBe(false);
  });
  test("the nine writers through the ROOT app: with a rate field ⇒ 403 before the service; without ⇒ the service runs", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: string[] = [];
    const spy = (mod: any, name: string, ret: any) => spies.push(spyOn(mod, name).mockImplementation((async () => { calls.push(name); return ret; }) as any));
    spy(sched, "createBooking", { id: "b" }); spy(sched, "editOtherBooking", { booking: { id: "b" } }); spy(sched, "createOtherSeries", { seriesKey: K, created: 1, bookingIds: ["x"] }); spy(sched, "createGroupSeries", { groupKey: K, created: 1, bookingIds: ["x"] });
    spy(series, "addTeacherToOtherSeries", { added: 1 }); spy(series, "updateOtherSeries", { updated: 1 }); spy(sched, "moveBooking", { id: "b" }); spy(sched, "updateCourse", { id: "c" }); spy(sched, "createCoursePackage", { course: { id: "c" }, bookings: [] });
    const other = { teacherId: T1, subjectId: SUBJ, date: "2026-10-05", startTime: "15:00", bookingType: "OTHER", otherTitle: "ECA", otherKind: "ECA", headCount: 12 };
    const seriesBody = { title: "ECA Club", otherKind: "ECA", headCount: 12, teacherId: T1, startTime: "15:00", dates: ["2026-10-05"] };
    const group = { name: "G", groupKind: "GROUP", seatCap: 6, teacherId: T1, startTime: "10:00", dates: ["2026-10-01"] };
    const course = { student: { id: A }, teacherId: T1, subjectId: SUBJ, size: 4, startDate: "2026-10-05", startTime: "10:00" };
    const cases: Array<[string, string, any, any]> = [
      ["POST", "/bookings", { ...other, teacherRates: { [T1]: 50000 } }, other],
      ["PATCH", `/bookings/${uuidFor("b-1")}/other`, { teacherRates: { [T1]: 50000 } }, { headCount: 10 }],
      ["POST", "/bookings/other-series", { ...seriesBody, teacherRates: { [T1]: 50000 } }, seriesBody],
      ["POST", "/bookings/group-series", { ...group, teacherRates: { [T1]: 50000 } }, group],
      ["POST", `/other-series/${K}/teachers`, { teacherId: T2, rateMinor: 40000 }, { teacherId: T2 }],
      ["PATCH", `/other-series/${K}`, { teacherRates: { [T1]: 1 } }, { title: "Chess" }],
      ["PATCH", `/bookings/${uuidFor("b-1")}`, { classRateMinor: 300 }, { date: "2026-10-12" }],
      ["PATCH", `/courses/${uuidFor("c-1")}`, { classRateMinor: 700 }, { adminUnlocked: true }],
      ["POST", "/courses", { ...course, duo: { coStudentId: B, classRateMinor: 40000 } }, { ...course, duo: { coStudentId: B } }],
    ];
    setUser(STAFF_NO59);
    for (const [m, p, withRate, without] of cases) {
      const r = await json(m, p, withRate);
      expect({ p, status: r.status }).toEqual({ p, status: 403 });
      expect(((await r.json()) as any).error.message).toBe("ไม่มีสิทธิ์แก้ค่าสอน");
      const ok = await json(m, p, without);
      expect({ p, status: ok.status }).toEqual({ p, status: m === "POST" ? 201 : 200 });
    }
    expect(calls).toHaveLength(9); // one service run per writer — only the rate-less bodies got through
    setUser(SUPER);
    for (const [m, p, withRate] of cases) expect((await json(m, p, withRate)).status).toBe(m === "POST" ? 201 : 200);
    expect(calls).toHaveLength(18);
  });
  test("the rate is OPTIONAL at the DUO create (validator + service); a DUO born without a default reads `rate: { null, null, null }`", () => {
    const course = { student: { id: A }, teacherId: T1, subjectId: SUBJ, size: 4, startDate: "2026-10-05", startTime: "10:00" };
    expect(v.createCoursePackage.safeParse({ ...course, duo: { coStudentId: B } }).success).toBe(true);
    expect(v.createCoursePackage.safeParse({ ...course, duo: { coStudentId: B, classRateMinor: 0 } }).success).toBe(true);
    expect(v.createCoursePackage.safeParse({ ...course, duo: { coStudentId: B, classRateMinor: -1 } }).success).toBe(false);
    expect(code(src("src/services/scheduler.service.ts"))).toContain("classRateMinor: input.duo?.classRateMinor ?? null,");
    expect(rateFacts({ bookingType: "COURSE_PACKAGE", teacherRateMinor: null }, { classRateMinor: null })).toEqual({ effectiveMinor: null, overrideMinor: null, defaultMinor: null });
    expect(effectiveRateMinor({ teacherRateMinor: null }, { classRateMinor: null })).toBeNull();
    // the other-series / group creates already take rates as optional
    expect(v.otherSeries.safeParse({ title: "x", otherKind: "ECA", headCount: 1, teacherId: T1, startTime: "15:00", dates: ["2026-10-05"] }).success).toBe(true);
    expect(v.groupSeries.safeParse({ name: "G", groupKind: "GROUP", seatCap: 6, teacherId: T1, startTime: "10:00", dates: ["2026-10-01"] }).success).toBe(true);
  });
  test("🚫 the budget mask untouched; no LINE renderer prints a rate; `PUT /teachers/:id/budget { rateMinor }` (57's hourly rate) is NOT under the coach-rate check", () => {
    expect(code(src("src/lib/budget-visibility.ts"))).not.toMatch(/teacherRates|coach-rate/);
    for (const f of ["src/lib/line-message.ts", "src/lib/daily-reminder.ts", "src/lib/line-today-schedule.ts"]) expect(code(src(f))).not.toMatch(/teacherRates|rateMinor|classRateMinor|effectiveMinor/);
    const API = code(src("src/routes/api.ts"));
    expect(API).toMatch(/\.put\("\/teachers\/:id\/budget", zValidator\("json", v\.setFreelanceBudget\), async \(c\) =>\n\s+c\.json\(await svc\.setFreelanceBudget\(/);
    expect((API.match(/assertMayEditCoachRate\(/g) ?? []).length).toBe(11); // 🔻 TASK-441: + the GROUP series' add-teacher + header PATCH
  });
});
