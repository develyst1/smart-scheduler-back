// TASK-431 (`REQ-102 §6/§7`) — the §13.3 coach rate behind ONE key, VIEW ⇔ EDIT coupled: `action:bookings.coach-rate` (59).
// The READ seam is ONE response walk at `/api/*` after the guard (`middleware/coach-rate-mask.ts`) that nulls exactly the
// keys `rate` / `classRateMinor` — pinned by a src scan that only the two mappers produce them; a super admin / a keyed
// staff pays nothing; a linked account is masked regardless; `/api/me` + `/api/permissions` byte-identical. The WRITE
// half: `assertMayEditCoachRate(body, viewer)` at the three routes (the `assertMayDiscount` shape) — a body carrying
// `classRateMinor` (incl. null) or `duo` without the key ⇒ 403 before the service; without the field the service runs.
// Independent of the budget key (57), both ways. No migration (50 = 50).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { COACH_RATE_KEY, COACH_RATE_KEYS, assertMayEditCoachRate, bodyEditsCoachRate, canSeeCoachRate, maskCoachRate } from "./coach-rate-visibility";
import { BUDGET_VIEW_KEY, canSeeBudget } from "./budget-visibility";
import { ACTION_KEYS, ACTION_REGISTRY, MENU_KEYS } from "./permissions";
import * as sched from "../services/scheduler.service";
import { toBookingDTO } from "../db/mappers";
import { DEV_USER } from "../middleware/auth";
import { db } from "../db";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const walk = (d: string): string[] => readdirSync(resolve(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const json = (method: string, path: string, body?: unknown) =>
  rootApp.fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", SUBJ = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const spies: Array<{ mockRestore: () => void }> = [];
const savedUser = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
const setUser = (u: { isSuperAdmin: boolean; grants?: Iterable<string>; teacherId?: string | null }) => {
  (DEV_USER as any).isSuperAdmin = u.isSuperAdmin; (DEV_USER as any).grants = new Set(u.grants ?? []); (DEV_USER as any).teacherId = u.teacherId ?? null;
};
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, savedUser); });
const ALL_BUT = (...drop: string[]) => [...MENU_KEYS, ...ACTION_KEYS.filter((k) => !drop.includes(k))];
const SUPER = { isSuperAdmin: true, grants: new Set<string>() };
const STAFF_NO59 = { isSuperAdmin: false, grants: new Set<string>(ALL_BUT(COACH_RATE_KEY)) };
const STAFF_59_NOT_57 = { isSuperAdmin: false, grants: new Set<string>(ALL_BUT(BUDGET_VIEW_KEY)) };
const STAFF_57_NOT_59 = { isSuperAdmin: false, grants: new Set<string>(ALL_BUT(COACH_RATE_KEY)) };
const LINKED_ALL = { isSuperAdmin: true, grants: new Set<string>([...MENU_KEYS, ...ACTION_KEYS]), teacherId: T1 };

describe("🔑 key 59 — registered, labelled, granted to nobody; a body-level key (no route carries it); independent of 57", () => {
  test("59 keys; `action:bookings.coach-rate` with TH/EN labels; the two exact response keys", () => {
    expect(ACTION_KEYS.length).toBe(59);
    expect(ACTION_REGISTRY.find((a) => a.key === COACH_RATE_KEY)).toMatchObject({ labelTh: "ดูและแก้ค่าสอน", labelEn: "View & edit coach rate" });
    expect([...COACH_RATE_KEYS]).toEqual(["rate", "classRateMinor"]);
  });
  test("`canSeeCoachRate`: the key · never a linked account · null ⇒ no; independent of `canSeeBudget` both ways (by value + by source)", () => {
    expect(canSeeCoachRate(SUPER)).toBe(true);
    expect(canSeeCoachRate(STAFF_NO59)).toBe(false);
    expect(canSeeCoachRate(STAFF_59_NOT_57)).toBe(true);
    expect(canSeeCoachRate(LINKED_ALL)).toBe(false);
    expect(canSeeCoachRate(null)).toBe(false);
    expect([canSeeCoachRate(STAFF_59_NOT_57), canSeeBudget(STAFF_59_NOT_57)]).toEqual([true, false]);
    expect([canSeeCoachRate(STAFF_57_NOT_59), canSeeBudget(STAFF_57_NOT_59)]).toEqual([false, true]);
    expect(code(src("src/lib/coach-rate-visibility.ts"))).not.toMatch(/budget-view|canSeeBudget|BUDGET_VIEW_KEY/);
    expect(code(src("src/lib/budget-visibility.ts"))).not.toMatch(/coach-rate|canSeeCoachRate|COACH_RATE_KEY/);
  });
});

describe("🔴 the READ mask — `maskCoachRate` by value; the seam by source (the two producers, the middleware after the guard)", () => {
  test("nulls exactly `rate` / `classRateMinor` at any depth; `teacherRates` / `hourlyRate` / a `rate` INSIDE another key's name untouched; non-objects pass through", () => {
    const body = { items: [{ id: "b", rate: { effectiveMinor: 300, overrideMinor: 300, defaultMinor: 700 }, other: { teacherRates: { [T1]: 500 } }, teacher: { hourlyRate: 500, rateMinor: 1 } }], course: { classRateMinor: 700, coStudent: { id: B }, nested: { deep: { classRateMinor: 1, rate: 2 } } }, n: 3, s: "x", nul: null };
    expect(maskCoachRate(body as any)).toEqual({ items: [{ id: "b", rate: null, other: { teacherRates: { [T1]: 500 } }, teacher: { hourlyRate: 500, rateMinor: 1 } }], course: { classRateMinor: null, coStudent: { id: B }, nested: { deep: { classRateMinor: null, rate: null } } }, n: 3, s: "x", nul: null });
    expect(maskCoachRate("text")).toBe("text");
    expect(maskCoachRate(null)).toBeNull();
    expect(maskCoachRate([1, { rate: 1 }] as any)).toEqual([1, { rate: null }]);
    expect(body.items[0]!.rate).not.toBeNull(); // a NEW value — the input is not mutated
  });
  test("🔴 the two producers: `rate:` and `classRateMinor:` as response keys appear ONLY in `db/mappers.ts` (`rateFacts`, `duoCourseFacts`) across src", () => {
    const producers = walk("src").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("coach-rate-visibility")).filter((f) => {
      const c = code(src(f));
      return /^\s*rate:\s/m.test(c) || /^\s*classRateMinor:\s(?!z\.|input|integer\()/m.test(c);
    });
    expect(producers).toEqual(["src/db/mappers.ts"]);
    const M = code(src("src/db/mappers.ts"));
    expect(M).toContain("rate: rateFacts(b, b.course ?? null),");
    expect(M).toContain("classRateMinor: c.classRateMinor ?? null,");
  });
  test("the middleware: registered on `/api/*` right after `accessGuard`; skips `/api/(auth|me|permissions)`; a keyed viewer untouched; JSON only", () => {
    const I = code(src("src/index.ts"));
    expect(I.indexOf('app.use("/api/*", accessGuard);')).toBeLessThan(I.indexOf('app.use("/api/*", coachRateMask);'));
    expect(I.indexOf('app.use("/api/*", coachRateMask);')).toBeLessThan(I.indexOf('app.route("/api/users", userRoutes);'));
    const MW = code(src("src/middleware/coach-rate-mask.ts"));
    expect(MW).toContain("const OUTSIDE = /^\\/api\\/(auth|me|permissions)(\\/|$)/;");
    expect(MW).toContain("if (canSeeCoachRate(viewerOf(c))) return;");
    expect(MW).toContain('includes("application/json")');
    expect(MW).toContain("c.res = new Response(JSON.stringify(maskCoachRate(body)), { status: res.status, headers: res.headers });");
  });
  test("by value through the ROOT app: `GET /bookings`, `GET /calendar`, `GET /courses`, `GET /entitlements/:id/plan` — super admin ⇒ figures; staff without 59 ⇒ nulls, all else byte-identical; linked-with-all ⇒ nulls; 59-not-57 ⇒ the rate and no budget; `/api/me` untouched", async () => {
    process.env.SKIP_AUTH = "true";
    const bookingRow = { id: "b-1", date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", bookingType: "COURSE_PACKAGE", status: "CONFIRMED", teacherId: T1, teacherRateMinor: 300, course: { id: "c-1", size: 4, usedSessions: 0, leaveUsed: 0, adminUnlocked: false, expiryDate: "2026-12-31", classRateMinor: 700, coStudentId: B }, student: { id: A, name: "Ploy" }, coStudent: { id: B, name: "Pun" }, teacher: { id: T1, name: "Bank", nickname: "Bank" }, subject: { id: SUBJ, name: "Balance" }, badges: [], additionalTeachers: [], rental: null, seats: [], group: null, campWeekDay: null };
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => [bookingRow]) as any));
    spies.push(spyOn(db.query.teachers, "findMany").mockImplementation((async () => [{ id: T1, name: "Bank", nickname: "Bank", type: "FREELANCE", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], teacherSubjects: [] }]) as any));
    spies.push(spyOn(db.query.boItem, "findMany").mockImplementation((async () => [{ ownerRef: T1, ceilingQty: 80, remainingQty: 30, unitPriceMinor: 50000, metadata: {} }]) as any));
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => null) as any));
    spies.push(spyOn(db.query.appSettings, "findMany").mockImplementation((async () => []) as any));
    spies.push(spyOn(db.query.campWeeks, "findMany").mockImplementation((async () => []) as any));
    spies.push(spyOn(db.query.coursePackages, "findMany").mockImplementation((async () => [{ id: "c-1", size: 4, usedSessions: 0, leaveUsed: 0, adminUnlocked: false, expiryDate: "2026-12-31", startDate: "2026-10-05", weekday: 1, startTime: "10:00:00", priorSessions: 0, leaveQuota: null, createdAt: new Date(), classRateMinor: 700, coStudentId: B, student: { id: A, name: "Ploy" }, coStudent: { id: B, name: "Pun" }, subject: { id: SUBJ, name: "Balance" }, bookings: [] }]) as any));
    spies.push(spyOn(db.query.coursePackages, "findFirst").mockImplementation((async () => ({ id: "c-1", size: 4, usedSessions: 0, leaveUsed: 0, adminUnlocked: false, expiryDate: "2026-12-31", startDate: "2026-10-05", weekday: 1, startTime: "10:00:00", priorSessions: 0, leaveQuota: null, studentId: A, classRateMinor: 700, coStudentId: B, coStudent: { id: B, name: "Pun" } })) as any));
    spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async () => ({ id: A, name: "Ploy", nickname: "Ploy" })) as any));
    spies.push(spyOn(sched, "getBookings").mockImplementation((async () => ({ items: [toBookingDTO(bookingRow)], page: 1, limit: 50, total: 1 })) as any)); // the table surface: the DTO flows through the mask
    const read = async () => ({
      bookings: ((await (await json("GET", "/bookings")).json()) as any).items?.[0],
      calendar: ((await (await json("GET", "/calendar?date=2026-10-05&view=day")).json()) as any).days?.[0]?.columns?.[0]?.slots?.find((s: any) => s.booking)?.booking,
      plan: (await (await json("GET", "/entitlements/c-1/plan")).json()) as any,
      me: (await (await json("GET", "/me")).json()) as any,
    });
    setUser(SUPER);
    const seen = await read();
    expect(seen.bookings?.rate).toEqual({ effectiveMinor: 300, overrideMinor: 300, defaultMinor: 700 });
    expect(seen.calendar?.rate).toEqual({ effectiveMinor: 300, overrideMinor: 300, defaultMinor: 700 });
    expect(seen.plan.classRateMinor).toBe(700);
    setUser(STAFF_NO59);
    const hidden = await read();
    expect(hidden.bookings.rate).toBeNull();
    expect(hidden.calendar.rate).toBeNull();
    expect(hidden.plan.classRateMinor).toBeNull();
    expect({ ...hidden.bookings, rate: seen.bookings.rate }).toEqual(seen.bookings); // everything else byte-identical
    expect({ ...hidden.plan, classRateMinor: 700 }).toEqual(seen.plan);
    expect(hidden.me.user.actions).not.toContain(COACH_RATE_KEY); // `/api/me` outside the mask, and honest about the key
    setUser(LINKED_ALL);
    expect((await read()).bookings.rate).toBeNull();
    setUser(STAFF_59_NOT_57);
    const r59 = await read();
    expect(r59.bookings.rate).toEqual({ effectiveMinor: 300, overrideMinor: 300, defaultMinor: 700 });
    expect(r59.calendar).toBeDefined();
    const teacher = ((await (await json("GET", "/teachers")).json()) as any).groups.flatMap((g: any) => Object.values(g).find(Array.isArray) ?? [])[0];
    expect(teacher).toMatchObject({ budgetMinor: null, remainingMinor: null }); // 59 without 57: no budget
    setUser(STAFF_57_NOT_59);
    expect((await read()).bookings.rate).toBeNull();
    expect(((await (await json("GET", "/teachers")).json()) as any).groups.flatMap((g: any) => Object.values(g).find(Array.isArray) ?? [])[0]).toMatchObject({ budgetMinor: 4000000 }); // 57 without 59: the budget, no rate
  });
});

describe("🔴 the WRITE half (view ⇔ edit) — `assertMayEditCoachRate` at the three routes; a body without the field passes", () => {
  test("`bodyEditsCoachRate` / `assertMayEditCoachRate` by value: `classRateMinor` (incl. null) and `duo` are edits; a body without them is not", () => {
    expect(bodyEditsCoachRate({ classRateMinor: 300 })).toBe(true);
    expect(bodyEditsCoachRate({ classRateMinor: null })).toBe(true);
    expect(bodyEditsCoachRate({ duo: { coStudentId: B, classRateMinor: 1 } })).toBe(true);
    expect(bodyEditsCoachRate({ date: "2026-10-12" })).toBe(false);
    expect(bodyEditsCoachRate(null)).toBe(false);
    expect(() => assertMayEditCoachRate({ date: "2026-10-12" }, STAFF_NO59)).not.toThrow();
    expect(() => assertMayEditCoachRate({ classRateMinor: 300 }, SUPER)).not.toThrow();
    expect(() => assertMayEditCoachRate({ classRateMinor: 300 }, STAFF_NO59)).toThrow(/ไม่มีสิทธิ์แก้ค่าสอน/);
    expect(() => assertMayEditCoachRate({ classRateMinor: null }, LINKED_ALL)).toThrow();
    expect(() => assertMayEditCoachRate({ duo: {} }, null)).toThrow();
  });
  test("by value through the ROOT app: the three writers ⇒ 403 without the key BEFORE the service; the move / the course PATCH without the field run; with the key everything runs", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: string[] = [];
    spies.push(spyOn(sched, "moveBooking").mockImplementation((async () => { calls.push("move"); return { id: "b" }; }) as any));
    spies.push(spyOn(sched, "updateCourse").mockImplementation((async () => { calls.push("course"); return { id: "c" }; }) as any));
    spies.push(spyOn(sched, "createCoursePackage").mockImplementation((async () => { calls.push("create"); return { course: { id: "c" }, bookings: [] }; }) as any));
    const course = { student: { id: A }, teacherId: T1, subjectId: SUBJ, size: 4, startDate: "2026-10-05", startTime: "10:00" };
    setUser(STAFF_NO59);
    const r1 = await json("PATCH", "/bookings/b-1", { classRateMinor: 300 });
    expect(r1.status).toBe(403);
    expect(await r1.json()).toEqual({ error: { code: "FORBIDDEN", message: "ไม่มีสิทธิ์แก้ค่าสอน" } });
    expect((await json("PATCH", "/bookings/b-1", { classRateMinor: null })).status).toBe(403);
    expect((await json("PATCH", "/courses/c-1", { classRateMinor: 700 })).status).toBe(403);
    expect((await json("POST", "/courses", { ...course, duo: { coStudentId: B, classRateMinor: 40000 } })).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await json("PATCH", "/bookings/b-1", { date: "2026-10-12" })).status).toBe(200); // the move without the field
    expect((await json("PATCH", "/courses/c-1", { adminUnlocked: true })).status).toBe(200);
    expect((await json("POST", "/courses", course)).status).toBe(201); // a Private create
    expect(calls).toEqual(["move", "course", "create"]);
    setUser(STAFF_59_NOT_57);
    expect((await json("PATCH", "/bookings/b-1", { classRateMinor: 300 })).status).toBe(200);
    expect((await json("PATCH", "/courses/c-1", { classRateMinor: 700 })).status).toBe(200);
    expect((await json("POST", "/courses", { ...course, duo: { coStudentId: B, classRateMinor: 40000 } })).status).toBe(201);
    expect(calls).toEqual(["move", "course", "create", "move", "course", "create"]);
  });
  test("by source: the three routes call `assertMayEditCoachRate(…, viewerOf(c))` before their service; no other route does; no migration", () => {
    const API = code(src("src/routes/api.ts"));
    expect((API.match(/assertMayEditCoachRate\(/g) ?? []).length).toBe(3);
    expect(API).toContain('assertMayEditCoachRate(body, viewerOf(c));');
    expect(API).toMatch(/assertMayEditCoachRate\(c\.req\.valid\("json"\), viewerOf\(c\)\);[^\n]*\n\s+return c\.json\(await svc\.moveBooking\(/);
    expect(API).toMatch(/assertMayEditCoachRate\(c\.req\.valid\("json"\), viewerOf\(c\)\);[^\n]*\n\s+return c\.json\(await svc\.updateCourse\(/);
    expect(readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).length).toBe(50);
  });
});
