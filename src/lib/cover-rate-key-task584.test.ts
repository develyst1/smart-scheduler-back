// TASK-584 — the cover door checks the rate key (key 59), with the SAME guard every other rate writer uses; a cover WITHOUT a rate is
// unaffected. And every rate writer DERIVED — from the body schemas and the route source, not from memory — with its guard named:
// the cover door hid because nobody had listed them.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { COACH_RATE_BODY_FIELDS, COACH_RATE_KEY, bodyEditsCoachRate } from "./coach-rate-visibility";
import { ACTION_KEYS, MENU_KEYS } from "./permissions";
import * as v from "../validation";
import * as series from "../services/other-series.service";
import { DEV_USER } from "../middleware/auth";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const json = (method: string, path: string, body?: unknown) =>
  rootApp.fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", T2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", K = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const spies: Array<{ mockRestore: () => void }> = [];
const savedUser = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
const setUser = (u: { isSuperAdmin: boolean; grants?: Iterable<string> }) => {
  (DEV_USER as any).isSuperAdmin = u.isSuperAdmin; (DEV_USER as any).grants = new Set(u.grants ?? []); (DEV_USER as any).teacherId = null;
};
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, savedUser); });
const SUPER = { isSuperAdmin: true, grants: new Set<string>() };
const STAFF_NO59 = { isSuperAdmin: false, grants: new Set<string>([...MENU_KEYS, ...ACTION_KEYS.filter((k) => k !== COACH_RATE_KEY)]) };

describe("🔴 TASK-584 — the cover door refuses a RATE without key 59, with a reason; a cover WITHOUT a rate is unaffected", () => {
  const cover = { from: T1, to: T2, onDate: "2026-10-12" };
  const arm = () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    spies.push(spyOn(series, "swapOtherSeriesTeacher").mockImplementation((async (key: string, input: any) => { calls.push([key, input]); return { moved: 1 }; }) as any));
    return calls;
  };
  test("no key 59 + a rate ⇒ 403 'ไม่มีสิทธิ์แก้ค่าสอน' BEFORE the service; no key 59 + no rate ⇒ 200, the service runs with the body as sent", async () => {
    const calls = arm();
    setUser(STAFF_NO59);
    const refused = await json("PATCH", `/other-series/${K}/teacher`, { ...cover, rateMinor: 45000 });
    expect([refused.status, ((await refused.json()) as any).error]).toEqual([403, expect.objectContaining({ code: "FORBIDDEN", message: "ไม่มีสิทธิ์แก้ค่าสอน" })]);
    expect(calls).toEqual([]);
    const ok = await json("PATCH", `/other-series/${K}/teacher`, cover);
    expect([ok.status, await ok.json()]).toEqual([200, { moved: 1 }]);
    expect(calls).toEqual([[K, cover]]); // a permission fix, not a functional change: the rate-less cover reaches the service unchanged
  });
  test("the key holder's cover with a rate still goes through (the whole door, not only its refusal)", async () => {
    const calls = arm();
    setUser(SUPER);
    expect((await json("PATCH", `/other-series/${K}/teacher`, { ...cover, rateMinor: 45000 })).status).toBe(200);
    expect(calls).toEqual([[K, { ...cover, rateMinor: 45000 }]]);
  });
});

// ── every rate writer, DERIVED: a route whose body schema accepts a rate field (at ANY depth) is a rate writer ──
const pathsOf = (s: any, pre = "", seen = new Set<any>()): string[] => {
  if (!s || seen.has(s)) return [];
  seen.add(s);
  const d = s._def, t = d?.type;
  if (t === "object") return Object.entries(s.shape).flatMap(([k, c]) => [pre + k, ...pathsOf(c, `${pre}${k}.`, seen)]);
  if (["optional", "nullable", "default", "prefault", "readonly", "catch", "nonoptional"].includes(t)) return pathsOf(d.innerType, pre, seen);
  if (t === "pipe") return pathsOf(d.in, pre, seen);
  if (t === "array") return pathsOf(d.element, `${pre}[].`, seen);
  if (t === "union") return d.options.flatMap((o: any) => pathsOf(o, pre, seen));
  if (t === "intersection") return [...pathsOf(d.left, pre, seen), ...pathsOf(d.right, pre, seen)];
  if (t === "record") return pathsOf(d.valueType, `${pre}*.`, seen);
  if (t === "lazy") return pathsOf(d.getter(), pre, seen);
  return [];
};
/** A body carrying a value at `path` (a rate field's path in the schema) — to ask the guard's own detector whether it SEES it. */
const bodyAt = (path: string): unknown => {
  const [head, ...rest] = path.split(".");
  if (!rest.length) return { [head!]: 1 };
  if (rest[0] === "[]") return { [head!]: [bodyAt(rest.slice(1).join("."))] };
  return { [head!]: bodyAt(rest.join(".")) };
};
const routeFiles = readdirSync(resolve(root, "src/routes")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const derive = () => {
  let validators = 0, matched = 0;
  const writers: string[] = [];
  const schemas: Array<{ route: string; paths: string[] }> = []; // TASK-585 — every validation.ts body, every path
  for (const f of routeFiles) {
    const S = readFileSync(resolve(root, "src/routes", f), "utf8").replace(/\r\n/g, "\n");
    validators += (S.match(/zValidator\("json"/g) ?? []).length;
    // the route's method + path, then (on the same line or the next ones, never past another route) its JSON body's schema
    const re = /\.(post|patch|put|delete)\(\s*"([^"]+)",(?:(?!\n\s*\.(?:get|post|patch|put|delete)\()[\s\S])*?zValidator\("json", (v\.)?(\w+)\)/g;
    for (let m; (m = re.exec(S)); ) {
      matched++;
      // a schema from `validation.ts` is walked; one declared in the route file itself is read from its declaration's text
      const local = S.slice(S.indexOf(`const ${m[4]} =`)).split(/\n(?:const|export|function) /)[0]!;
      const ratePaths = m[3]
        ? pathsOf((v as any)[m[4]!]).filter((p) => (COACH_RATE_BODY_FIELDS as readonly string[]).includes(p.split(".").pop()!))
        : COACH_RATE_BODY_FIELDS.filter((f) => new RegExp(`\\b${f}\\s*:`).test(local));
      if (!m[3] && !S.includes(`const ${m[4]} =`)) throw new Error(`schema ${m[4]} not found in ${f}`);
      if (m[3]) schemas.push({ route: `${m[1]!.toUpperCase()} ${m[2]}`, paths: pathsOf((v as any)[m[4]!]) });
      if (!ratePaths.length) continue;
      const next = S.slice(m.index + 1).search(/\n\s*\.(get|post|patch|put|delete)\(/);
      const handler = S.slice(m.index, next < 0 ? undefined : m.index + 1 + next);
      const guard = handler.includes("assertMayEditCoachRate(") ? "key59" : "NONE";
      const unseen = guard === "key59" ? ratePaths.filter((p) => !bodyEditsCoachRate(bodyAt(p))) : [];
      writers.push(`${f.replace(/\.ts$/, "")} ${m[1]!.toUpperCase()} ${m[2]} · ${ratePaths.join(",")} · ${guard}${unseen.length ? ` · UNSEEN ${unseen.join(",")}` : ""}`);
    }
  }
  return { validators, matched, writers, schemas };
};

describe("🔑 TASK-584 — EVERY rate writer, derived from the schemas + the route source, with its guard named", () => {
  test("the derivation reads EVERY JSON body in the routes (none skipped by the pattern)", () => {
    const { validators, matched } = derive();
    expect(matched).toBe(validators);
    expect(validators).toBeGreaterThan(90);
  });
  test("the list — a NEW rate writer, a guard removed, or a rate field the guard cannot see changes this list", () => {
    expect(derive().writers.sort()).toEqual([
      "api PATCH /bookings/:id · classRateMinor · key59",
      // 🔻 TASK-634 — the two GROUP-swap doors joined the list the day they started taking a `rateMinor`. 🔑 They arrive here
      // DERIVED, each already carrying · key59 — which is the proof that widening those doors did not widen who may price a
      // coach: the guard reads the BODY, so a door that takes a rate is gated the moment it takes one.
      "api PATCH /bookings/:id/group-teacher · rateMinor · key59",
      "api PATCH /group-series/:key/teacher · rateMinor · key59",
      "api PATCH /bookings/:id/other · teacherRates · key59",
      "api PATCH /courses/:id · classRateMinor · key59",
      "api PATCH /group-series/:key · teacherRates · key59",
      "api PATCH /other-series/:key · teacherRates · key59",
      "api PATCH /other-series/:key/teacher · rateMinor · key59", // ✅ TASK-584 — was NONE
      "api POST /bookings · teacherRates · key59",
      "api POST /bookings/group-series · teacherRates · key59",
      "api POST /bookings/other-series · teacherRates · key59",
      "api POST /courses · duo.classRateMinor · key59",
      "api POST /group-series/:key/teachers · rateMinor · key59",
      "api POST /other-series/:key/teachers · rateMinor · key59",
      "api PUT /teachers/:id/budget · rateMinor · NONE", // ✅ BY DESIGN (TASK-434's pin): key 57's freelance hourly rate, under `teachers.budget`, NOT key 59
      // ✅ TASK-585 — was `· UNSEEN teachers.[].rateMinor`: the guard was CALLED but its detector read the top level (+ `duo`) only
      "camp PATCH /weeks/:id/days/:date · teachers.[].rateMinor,teacherRates · key59",
    ].sort());
  });
});

// ───────────────────────── TASK-585 — the detector reads a rate at ANY depth; derived from the schemas, pinned both ways ─────────────────────────
describe("🔴 TASK-585 — `bodyEditsCoachRate` sees a rate at every depth, and ONLY a rate", () => {
  test("DERIVED from every body schema: a body at each RATE path is detected; a body at each OTHER path is NOT (the false-positive half)", () => {
    const { schemas } = derive();
    const isRate = (p: string) => (COACH_RATE_BODY_FIELDS as readonly string[]).includes(p.split(".").pop()!);
    const wrong = schemas.flatMap(({ route, paths }) => paths.filter((p) => bodyEditsCoachRate(bodyAt(p)) !== isRate(p)).map((p) => `${route} · ${p}`));
    expect(wrong).toEqual([]);
    const all = schemas.flatMap((x) => x.paths);
    expect([all.filter(isRate).length >= 15, all.filter((p) => !isRate(p)).length > 300]).toEqual([true, true]); // the sweep is not vacuous
    expect(all.some((p) => p.split(".").length > 2 && isRate(p))).toBe(true); // …and it includes a NESTED rate (the camp day's)
  });
  const T3 = "ffffffff-ffff-4fff-8fff-ffffffffffff", SUBJ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const other = { teacherId: T1, subjectId: SUBJ, date: "2026-10-05", startTime: "15:00", bookingType: "OTHER", otherTitle: "ECA", otherKind: "ECA", headCount: 12 };
  const seriesBody = { title: "ECA Club", otherKind: "ECA", headCount: 12, teacherId: T1, startTime: "15:00", dates: ["2026-10-05"] };
  const group = { name: "G", groupKind: "GROUP", seatCap: 6, teacherId: T1, startTime: "10:00", dates: ["2026-10-01"] };
  const course = { student: { id: T3 }, teacherId: T1, subjectId: SUBJ, size: 4, startDate: "2026-10-05", startTime: "10:00" };
  // the 14 writers' REAL bodies: [door, with a rate, without one]
  const real: Array<[string, object, object]> = [
    ["POST /bookings", { ...other, teacherRates: { [T1]: 50000 } }, other],
    ["PATCH /bookings/:id (Move session)", { teacherId: T2, classRateMinor: 300 }, { teacherId: T2, date: "2026-10-12" }],
    ["PATCH /bookings/:id/other", { teacherRates: { [T1]: 50000 } }, { headCount: 10, otherKind: "ECA" }],
    ["POST /bookings/other-series", { ...seriesBody, teacherRates: { [T1]: 50000 } }, seriesBody],
    ["POST /bookings/group-series", { ...group, teacherRates: { [T1]: 50000 } }, group],
    ["POST /courses", { ...course, duo: { coStudentId: T2, classRateMinor: 40000 } }, { ...course, duo: { coStudentId: T2 } }],
    ["PATCH /courses/:id", { classRateMinor: 700 }, { adminUnlocked: true }],
    ["PATCH /other-series/:key", { teacherRates: { [T1]: 1 } }, { title: "Chess" }],
    ["POST /other-series/:key/teachers", { teacherId: T2, rateMinor: 40000, onDate: "2026-10-12" }, { teacherId: T2, onDate: "2026-10-12" }],
    ["PATCH /other-series/:key/teacher (the cover)", { from: T1, to: T2, onDate: "2026-10-12", rateMinor: 45000 }, { from: T1, to: T2, onDate: "2026-10-12" }],
    ["PATCH /group-series/:key", { teacherRates: { [T1]: 1 } }, { name: "G2" }],
    ["POST /group-series/:key/teachers", { teacherId: T2, rateMinor: 40000, fromDate: "2026-10-12" }, { teacherId: T2, fromDate: "2026-10-12" }],
    ["PATCH /camp/weeks/:id/days/:date", { teachers: [{ teacherId: T1 }, { teacherId: T2, startTime: "09:00", endTime: "12:00", rateMinor: 60000 }] }, { teachers: [{ teacherId: T1 }, { teacherId: T2, startTime: "09:00", endTime: "12:00" }], startTime: "09:00" }],
    // key 57's door (NOT guarded by 59, by design): the detector would see its rate — the ROUTE does not ask it (TASK-584's list pins that)
    ["PUT /teachers/:id/budget", { monthlyBudgetMinor: 1000000, rateMinor: 50000 }, { monthlyBudgetMinor: 1000000 }],
  ];
  test("the 14 writers' REAL bodies, both directions: with a rate ⇒ detected · without ⇒ NOT detected", () => {
    expect(real).toHaveLength(14);
    expect(real.map(([door, withRate, without]) => [door, bodyEditsCoachRate(withRate), bodyEditsCoachRate(without)])).toEqual(real.map(([door]) => [door, true, false]));
  });
  test("🔴 the camp day THROUGH THE ROOT APP: no key 59 + ONLY `teachers[].rateMinor` ⇒ 403 with the reason, the service never reached; the roster alone ⇒ 200", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const campSvc = await import("../services/camp.service");
    spies.push(spyOn(campSvc, "updateWeekDay").mockImplementation((async (...a: any[]) => { calls.push(a[2]); return { ok: true }; }) as any));
    setUser(STAFF_NO59);
    const W = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const refused = await json("PATCH", `/camp/weeks/${W}/days/2026-10-12`, real[12]![1]);
    expect([refused.status, ((await refused.json()) as any).error?.message]).toEqual([403, "ไม่มีสิทธิ์แก้ค่าสอน"]);
    expect(calls).toEqual([]);
    const ok = await json("PATCH", `/camp/weeks/${W}/days/2026-10-12`, real[12]![2]);
    expect(ok.status).toBe(200);
    expect(calls).toEqual([real[12]![2]]);
  });
});
