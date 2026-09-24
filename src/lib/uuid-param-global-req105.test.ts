// TASK-451 — the uuid-param guard goes GLOBAL (`/api/*`). TASK-450 built it and mounted it on `/api/camp/*` because
// ~21 suites called the root app with fixture ids like `"b1"`; the fixture was the thing that was wrong, so the
// fixtures moved (a deterministic `uuidFor(seed)` keeps each one's NAME readable) and the mount is now one line for
// the whole API. This pins: the helper, the global mount by value on non-camp routes, the rule that a 403 still beats
// a 400, and the census — `date · id · key · teacherId` are the only param names, so a fifth shape fails the suite.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROUTE_ACCESS } from "./route-access";
import { FREE_FORM_PARAMS, badUuidParams, isUuid } from "../middleware/uuid-params";
import { uuidFor } from "./test-uuid";
import { DEV_USER } from "../middleware/auth";
import * as sched from "../services/scheduler.service";
import * as parentSvc from "../services/parent.service";
import { db } from "../db";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const json = (method: string, path: string, body?: unknown) =>
  rootApp.fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const spies: Array<{ mockRestore: () => void }> = [];
const savedUser = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
const setUser = (u: { isSuperAdmin: boolean; grants?: Iterable<string> }) => {
  (DEV_USER as any).isSuperAdmin = u.isSuperAdmin; (DEV_USER as any).grants = new Set(u.grants ?? []); (DEV_USER as any).teacherId = null;
};
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, savedUser); });

describe("🔴 `uuidFor` — a fixture keeps its NAME and gains a real id", () => {
  test("deterministic, uuid-shaped, distinct per seed, stable across calls", () => {
    expect(isUuid(uuidFor("b-1"))).toBe(true);
    expect(uuidFor("b-1")).toBe(uuidFor("b-1"));
    expect(uuidFor("b-1")).not.toBe(uuidFor("b-2"));
    expect(uuidFor("gone")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(badUuidParams("/api/students/:id", `/api/students/${uuidFor("gone")}`)).toEqual([]);
    // 🚫 tests only — nothing in `src/` outside a test may depend on it
    expect(src("src/lib/test-uuid.ts")).toContain("🚫 Not for product code."); // the note survives only in the RAW source
    expect(code(src("src/lib/test-uuid.ts"))).toContain("export function uuidFor(seed: string): string {");
  });
});

describe("🔴 the GLOBAL mount — every route, not just camp", () => {
  test("by source: `/api/*`, still AFTER the access guard (a 403 must beat a 400)", () => {
    const IDX = code(src("src/index.ts"));
    expect(IDX).toContain('app.use("/api/*", uuidParamGuard);');
    expect(IDX).not.toContain('app.use("/api/camp/*", uuidParamGuard);');
    expect(IDX.indexOf('app.use("/api/*", accessGuard)')).toBeLessThan(IDX.indexOf('app.use("/api/*", uuidParamGuard)'));
    expect(IDX.indexOf('app.use("/api/*", authMiddleware)')).toBeLessThan(IDX.indexOf('app.use("/api/*", uuidParamGuard)'));
  });
  test("🔴 by value on NON-camp routes: a malformed id ⇒ 400, the service never called; a real id still goes through", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: string[] = [];
    spies.push(spyOn(parentSvc, "deleteStudent").mockImplementation((async () => { calls.push("deleteStudent"); return { deleted: true }; }) as any));
    spies.push(spyOn(sched, "updateCourse").mockImplementation((async () => { calls.push("updateCourse"); return { course: {} }; }) as any));
    spies.push(spyOn(sched, "getEntitlementPlan").mockImplementation((async () => { calls.push("getEntitlementPlan"); return { sessions: [] }; }) as any));
    for (const [m, p] of [["DELETE", "/students/undefined"], ["PATCH", "/courses/undefined"], ["GET", "/entitlements/undefined/plan"], ["PATCH", "/courses/null"], ["DELETE", "/students/b1"]] as const) {
      const res = await json(m, p);
      expect({ p, status: res.status }).toEqual({ p, status: 400 });
      expect({ p, body: ((await res.json()) as any).error.message.includes("id") }).toEqual({ p, body: true });
    }
    expect(calls).toEqual([]); // not one service call for any of them
    expect((await json("DELETE", `/students/${uuidFor("gone")}`)).status).toBe(200);
    expect(calls).toEqual(["deleteStudent"]);
  });
  test("🔑 a 403 still beats a 400: a caller without the key gets the REFUSAL, not the shape of the route", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: string[] = [];
    spies.push(spyOn(parentSvc, "deleteStudent").mockImplementation((async () => { calls.push("deleteStudent"); return { deleted: true }; }) as any));
    setUser({ isSuperAdmin: false, grants: [] }); // no menu, no action
    expect((await json("DELETE", "/students/undefined")).status).toBe(403);
    setUser({ isSuperAdmin: true });
    expect((await json("DELETE", "/students/undefined")).status).toBe(400);
    expect(calls).toEqual([]);
  });
  test("`:teacherId` is guarded too; `:key` and `:date` still pass anything (a settings key is not a uuid)", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: string[] = [];
    spies.push(spyOn(await import("../services/settings.service"), "setSetting").mockImplementation((async () => { calls.push("setSetting"); return { key: "x", value: "on" }; }) as any));
    expect((await json("DELETE", `/other-series/${uuidFor("k")}/teachers/nope`)).status).toBe(400);
    expect((await json("PUT", "/settings/camp_reminder_enabled", { value: "on" })).status).toBe(200);
    expect(calls).toEqual(["setSetting"]);
  });
});

describe("🔴 the census — the API has FOUR param names, and a fifth must not slip in quietly", () => {
  test("`date · id · key · teacherId` — and the free-form ones are declared per ROUTE, not excluded by NAME", () => {
    const names = [...new Set(Object.keys(ROUTE_ACCESS).flatMap((k) => k.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1))))].sort();
    expect(names).toEqual(["date", "id", "key", "teacherId"]);
    // 🔴 TASK-463 (DEF-2) — this test used to pin the exclusion BY NAME (`date`, `key` never checked). That rule is
    // exactly what let `/other-series/undefined` reach Postgres: the series routes named a UUID `:key`. So the claim
    // moves: every route with a free-form param is LISTED, and every other param in the table is a uuid.
    const freeRoutes = Object.keys(ROUTE_ACCESS).filter((k) => /:(key|date)\b/.test(k)).map((k) => `/api${k.slice(k.indexOf(" ") + 1)}`);
    const declared = freeRoutes.filter((p) => FREE_FORM_PARAMS[p]);
    expect(declared.sort()).toEqual(["/api/camp/weeks/:id/days/:date", "/api/settings/:key", "/api/settings/:key"].sort());
    // …and the SERIES `:key` routes are NOT declared — so the guard checks them (that is DEF-2, fixed)
    expect(freeRoutes.filter((p) => /series\/:key/.test(p) && FREE_FORM_PARAMS[p])).toEqual([]);
    // a fifth shape (`:code`, `:slug`, `:token`…) is neither guarded nor listed ⇒ this assertion fails the suite,
    // which is the point: the next route cannot add one without a decision.
    for (const invented of ["code", "slug", "token", "phone"]) expect(names).not.toContain(invented);
  });
});
