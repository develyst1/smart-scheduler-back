// TASK-463 — DEF-3 (HIGH): a `menu:camp` user without key 59 read every coach's pay on a camp day.
//
// 🔑 THE WALK, and why it exists: **the next new rate field must fail this suite on the day it is written — not on
// the day a customer's staff reads someone's pay.** TASK-454 added `teachers[].rateMinor` to the camp day DTO and
// nothing failed, because TASK-434's by-absence pin scanned for `rateMinor:` at the START of a line
// (`/^\s*rateMinor:\s/m`) — and the new producer was a one-line object literal, with the key in the MIDDLE of its
// line. The pin checked how the code was LAID OUT, not what the API emits.
//
// So this walk does not care about layout: it finds every rate-shaped key ANYWHERE in `src` and requires each one to
// be either in the mask's ONE declared set, or named below as not-a-coach-rate WITH the reason.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { COACH_RATE_BODY_FIELDS, COACH_RATE_FIELDS, COACH_RATE_KEY, COACH_RATE_KEYS, maskCoachRate } from "./coach-rate-visibility";
import { ACTION_KEYS, MENU_KEYS } from "./permissions";
import { DEV_USER } from "../middleware/auth";
import { readSrc } from "./read-src";
import { uuidFor } from "./test-uuid";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const walk = (d: string): string[] => readdirSync(resolve(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const camp = await import("../services/camp.service");
const other = await import("../services/other-series.service");
const settingsSvc = await import("../services/settings.service");
const { badUuidParams, FREE_FORM_PARAMS } = await import("../middleware/uuid-params");
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };

const spies: Array<{ mockRestore: () => void }> = [];
const savedUser = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
const setUser = (u: { isSuperAdmin: boolean; grants?: Iterable<string> }) => {
  (DEV_USER as any).isSuperAdmin = u.isSuperAdmin; (DEV_USER as any).grants = new Set(u.grants ?? []); (DEV_USER as any).teacherId = null;
};
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, savedUser); });
const ALL_BUT = (...drop: string[]) => [...MENU_KEYS, ...ACTION_KEYS.filter((k) => !drop.includes(k))];

/**
 * Rate-shaped names that are NOT a coach's pay — each with its reason. 🔑 Adding a name here is a DECISION a reviewer
 * can read; forgetting to add one is a failing test. That is the whole mechanism.
 */
const NOT_A_COACH_RATE: Record<string, string> = {
  hourlyRate: "key 57's freelance budget figure — masked by `budget-visibility.ts`, deliberately independent of key 59",
  rates: "a LOCAL variable / parameter name (`const rates: Record<…>`, `assertRatesOnBooking(rates, …)`), never a response key",
  migrate: "the word 'migrate' (`migrate-preflight.ts`) — the pattern's own false positive, listed so the list is honest",
};

/** Every distinct key in `src` that looks like a rate — `name:` or `name?:` ANYWHERE on a line, one-liners included. */
const RATE_SHAPED = /\b([a-zA-Z]*[Rr]ate(?:s|Minor)?)\s*\??:/g;
const rateShapedKeys = (): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const f of walk("src").filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
    const s = code(readSrc(readFileSync(resolve(root, f), "utf8")));
    for (const m of s.matchAll(RATE_SHAPED)) out.set(m[1]!, [...(out.get(m[1]!) ?? []), f]);
  }
  return out;
};

describe("🔑 TASK-463 — THE WALK: every rate-shaped key in src is masked, or named as not-a-coach-rate with a reason", () => {
  test("🔴 no rate-shaped key is UNCLASSIFIED", () => {
    const masked = new Set<string>(COACH_RATE_KEYS);
    const unclassified = [...rateShapedKeys().entries()]
      .filter(([k]) => !masked.has(k) && !(k in NOT_A_COACH_RATE))
      .map(([k, files]) => `${k} (${[...new Set(files)].join(", ")})`);
    expect(unclassified).toEqual([]);
  });

  test("📌 the walk is NOT layout-bound: a one-line literal is found, which is exactly what TASK-434's pin missed", () => {
    const oneLiner = `  .map((t) => ({ teacherId: t.id, startTime: s, endTime: e, rateMinor: t.rateMinor ?? 0 }))`;
    expect([...oneLiner.matchAll(RATE_SHAPED)].map((m) => m[1])).toContain("rateMinor");
    expect(/^\s*rateMinor:\s/m.test(oneLiner)).toBe(false); // 🔴 TASK-434's regex, on the very line that leaked
  });

  test("🚫 the guard on the guard: a NEW rate field would fail today, and the allow-list is not a silent pass", () => {
    const masked = new Set<string>(COACH_RATE_KEYS);
    for (const invented of ["coachRateMinor", "extraRate", "teacherRatesByDay"]) {
      expect({ invented, classified: masked.has(invented) || invented in NOT_A_COACH_RATE }).toEqual({ invented, classified: false });
    }
    // every allow-list entry must still OCCUR in src — a stale exemption is how an allow-list turns into a blind spot
    const found = rateShapedKeys();
    expect(Object.keys(NOT_A_COACH_RATE).filter((k) => !found.has(k))).toEqual([]);
  });

  test("🔑 ONE declared set: the read keys ARE the set, the body fields are the set minus the READ-ONLY names", () => {
    expect(COACH_RATE_KEYS).toBe(COACH_RATE_FIELDS);
    expect([...COACH_RATE_FIELDS]).toEqual(["rate", "classRateMinor", "teacherRates", "rateMinor", "teacherRateMinor"]);
    expect([...COACH_RATE_BODY_FIELDS]).toEqual(["classRateMinor", "teacherRates", "rateMinor"]);
  });
});

describe("🔴 TASK-463 — DEF-3 by value, through the ROOT app: the camp day's `teachers[].rateMinor`", () => {
  const W = uuidFor("w-463"), D = uuidFor("d-463"), T1 = uuidFor("t1-463"), T2 = uuidFor("t2-463");
  // the REAL producer's output (`campDayTeachers`), in the day DTO's shape — so the field names the mask sees are the
  // ones the camp service actually emits, not ones typed in this test
  const teachers = camp.campDayTeachers({
    startTime: "09:00:00", endTime: "15:00:00",
    teachers: [{ teacherId: T1, startTime: null, endTime: null, rateMinor: 60000 }, { teacherId: T2, startTime: "10:00:00", endTime: "12:00:00", rateMinor: 45000 }],
  });
  const dayDTO = { days: [{ campWeekDayId: D, date: "2026-10-06", teachers, teacherIds: [T1, T2], teacherRates: { [T1]: 60000, [T2]: 45000 } }] };

  const read = async (grants: Iterable<string>) => {
    process.env.SKIP_AUTH = "true";
    setUser({ isSuperAdmin: false, grants });
    spies.push(spyOn(camp, "weekDays").mockImplementation((async () => dayDTO) as any));
    const res = await rootApp.fetch(new Request(`http://localhost/api/camp/weeks/${W}/days`));
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  };

  test("🔴 WITHOUT key 59: every `rateMinor` is null — and the coach, the hours and the day are all still there", async () => {
    const body = await read(ALL_BUT(COACH_RATE_KEY));
    expect(body.days[0].teachers).toEqual([
      { teacherId: T1, startTime: "09:00", endTime: "15:00", rateMinor: null },
      { teacherId: T2, startTime: "10:00", endTime: "12:00", rateMinor: null },
    ]);
    expect(body.days[0].teacherRates).toBeNull(); // the third surface, masked since TASK-434 — still masked
  });

  test("WITH key 59: the pay is there, unchanged", async () => {
    const body = await read([...MENU_KEYS, ...ACTION_KEYS]);
    expect(body.days[0].teachers.map((t: any) => t.rateMinor)).toEqual([60000, 45000]);
    expect(body.days[0].teacherRates).toEqual({ [T1]: 60000, [T2]: 45000 });
  });

  test("📌 the mask itself: a raw `teacherRateMinor` (a bookings column) is masked too — a raw row cannot leak it either", () => {
    expect(maskCoachRate({ row: { teacherRateMinor: 50000, hourlyRate: 500 } } as any)).toEqual({ row: { teacherRateMinor: null, hourlyRate: 500 } });
  });
});

// ═══════════════════ DEF-2 — the uuid guard decides by ROUTE ═══════════════════

describe("🔴 TASK-463 — DEF-2 by value, through the ROOT app: a malformed series key is a 400, never a 500", () => {
  const asStaff = () => { process.env.SKIP_AUTH = "true"; setUser({ isSuperAdmin: true, grants: [...MENU_KEYS, ...ACTION_KEYS] }); };

  test("🔴 `/other-series/undefined` and `/group-series/undefined` answer 400 — and the service is NEVER called", async () => {
    asStaff();
    let calls = 0;
    spies.push(spyOn(other, "getOtherSeries").mockImplementation((async () => { calls++; return {}; }) as any));
    for (const path of ["/api/other-series/undefined", "/api/group-series/undefined"]) {
      const res = await rootApp.fetch(new Request(`http://localhost${path}`));
      expect({ path, status: res.status }).toEqual({ path, status: 400 });
    }
    expect(calls).toBe(0); // 🔑 before this task the value reached Postgres as `22P02` ⇒ 500
  });

  test("…and a REAL series key still gets through", async () => {
    asStaff();
    spies.push(spyOn(other, "getOtherSeries").mockImplementation((async () => ({ key: "ok" })) as any));
    const res = await rootApp.fetch(new Request(`http://localhost/api/other-series/${uuidFor("series-463")}`));
    expect(res.status).toBe(200);
  });

  test("📌 `/settings/:key` still takes a SETTINGS key — the one route that genuinely declares it free-form", async () => {
    asStaff();
    const calls: string[] = [];
    spies.push(spyOn(settingsSvc, "resetSetting").mockImplementation((async (k: string) => { calls.push(k); return { key: k }; }) as any));
    const res = await rootApp.fetch(new Request("http://localhost/api/settings/checkin_early_minutes", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(calls).toEqual(["checkin_early_minutes"]);
  });

  test("🚫 the rule is by ROUTE: the same NAME is free on one route and a uuid on another; a NEW free-form param fails closed", () => {
    expect(badUuidParams("/api/settings/:key", "/api/settings/checkin_early_minutes")).toEqual([]);
    expect(badUuidParams("/api/other-series/:key", "/api/other-series/checkin_early_minutes")).toEqual(["key"]);
    expect(badUuidParams("/api/some-new-route/:slug", "/api/some-new-route/hello")).toEqual(["slug"]); // undeclared ⇒ refused
    expect(Object.keys(FREE_FORM_PARAMS).sort()).toEqual(["/api/calendar/:file", "/api/camp/weeks/:id/days/:date", "/api/settings/:key"]);
  });
});
