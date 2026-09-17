// TASK-385 (`REQ-092` RBAC, SPEC-079 Stage 3) — the `action:*` registry with labels, the action column on the ONE
// route table, the guard's second check with its OWN sentence, the two body-level acts (discount, leave override),
// `PUT /users/:id/actions`, `/me.actions`, `GET /permissions`. The enumeration is Stage 2's extended: every mutate
// route carries an action, every action key is used, no unknown key.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTION_AREAS, ACTION_KEYS, ACTION_REGISTRY, MENU_KEYS, PERMISSION_REGISTRY, actionsOf, assertMayOverrideLeave, hasAction, isActionKey, isMenuKey } from "./permissions";
import { ROUTE_ACCESS } from "./route-access";
import { authMiddleware, accessGuard, requireAction } from "../middleware/auth";
import { ApiException } from "./http";
import { signToken } from "./jwt";
import * as usersSvc from "../services/user.service";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };

describe("🔑 the registry — 46 keys, one rule, labels beside the keys", () => {
  test("46 keys, every one `action:<area>.<verb>` with a known area, TH + EN labels, no duplicates", () => {
    expect(ACTION_KEYS.length).toBe(46);
    expect(new Set(ACTION_KEYS).size).toBe(46);
    for (const a of ACTION_REGISTRY) {
      const m = /^action:([a-z-]+)\.([a-z-]+)$/.exec(a.key);
      expect({ key: a.key, ok: !!m && (ACTION_AREAS as readonly string[]).includes(m[1]!) && a.area === m[1] }).toEqual({ key: a.key, ok: true });
      expect({ key: a.key, th: a.labelTh.length > 0, en: a.labelEn.length > 0 }).toEqual({ key: a.key, th: true, en: true });
    }
  });
  test("the areas are the menu tails + `sales` (the one non-menu area); every area is used", () => {
    const tails = MENU_KEYS.map((m) => m.slice("menu:".length));
    for (const a of ACTION_AREAS) expect({ a, ok: a === "sales" || tails.includes(a) }).toEqual({ a, ok: true });
    expect(new Set(ACTION_REGISTRY.map((a) => a.area))).toEqual(new Set(ACTION_AREAS));
  });
  test("the two body-level keys by value; a menu key is not an action key and vice versa", () => {
    expect(ACTION_REGISTRY.find((a) => a.key === "action:sales.discount")).toEqual({ key: "action:sales.discount", area: "sales", labelTh: "ให้ส่วนลด", labelEn: "Give a discount" });
    expect(ACTION_REGISTRY.find((a) => a.key === "action:calendar.leave-override")).toEqual({ key: "action:calendar.leave-override", area: "calendar", labelTh: "ยกเว้นกฎแจ้งลาล่วงหน้า", labelEn: "Override the leave-notice rule" });
    expect(isActionKey("menu:calendar")).toBe(false);
    expect(isMenuKey("action:calendar.book")).toBe(false);
    expect(isActionKey("action:calendar.nope")).toBe(false);
  });
  test("`hasAction`: a super admin has all; a user needs THE grant (a menu grant is not an action grant); nobody ⇒ false", () => {
    expect(hasAction({ isSuperAdmin: true, grants: new Set() }, "action:settings.edit")).toBe(true);
    expect(hasAction({ isSuperAdmin: false, grants: new Set(["action:calendar.book"]) }, "action:calendar.book")).toBe(true);
    expect(hasAction({ isSuperAdmin: false, grants: new Set(["menu:calendar"]) }, "action:calendar.book")).toBe(false);
    expect(hasAction(null, "action:calendar.book")).toBe(false);
  });
  test("`actionsOf`: a super admin ⇒ all 46 in registry order; a user ⇒ their grants in that order, non-action keys ignored", () => {
    expect(actionsOf({ isSuperAdmin: true, grants: new Set() })).toEqual([...ACTION_KEYS]);
    expect(actionsOf({ isSuperAdmin: false, grants: new Set(["action:settings.edit", "menu:calendar", "action:calendar.book"]) })).toEqual(["action:calendar.book", "action:settings.edit"]);
  });
  test("`PERMISSION_REGISTRY` is the menus (keys) + the actions (with labels) — the FE's only source of names", () => {
    expect(PERMISSION_REGISTRY.menus).toBe(MENU_KEYS);
    expect(PERMISSION_REGISTRY.actions).toBe(ACTION_REGISTRY);
  });
});

describe("🔴 the enumeration — every mutate route carries an action, no read does, every key is used, no unknown key", () => {
  const ROUTES = readSrc(readFileSync(resolve(root, "src/routes/api.ts"), "utf8"));
  const declared = [...ROUTES.matchAll(/\.(get|post|patch|put|delete)\(\s*"(\/[^"]*)"/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
  test("58 mutate routes (the floor), each with a known action; every GET without one", () => {
    const mutate = declared.filter((r) => !r.startsWith("GET "));
    expect(mutate.length).toBeGreaterThanOrEqual(58);
    const missing = mutate.filter((r) => !ROUTE_ACCESS[r]?.action || !isActionKey(ROUTE_ACCESS[r]!.action!));
    expect(missing).toEqual([]);
    const readsWithAction = declared.filter((r) => r.startsWith("GET ") && ROUTE_ACCESS[r]?.action);
    expect(readsWithAction).toEqual([]);
  });
  test("every route key is used by ≥ 1 route; the two body-level keys are used by NONE (they are checked at the body)", () => {
    const used = new Set(Object.values(ROUTE_ACCESS).map((a) => a.action).filter(Boolean));
    const bodyLevel = ["action:sales.discount", "action:calendar.leave-override"];
    const unused = ACTION_KEYS.filter((k) => !used.has(k) && !bodyLevel.includes(k));
    expect(unused).toEqual([]);
    for (const k of bodyLevel) expect({ k, used: used.has(k as any) }).toEqual({ k, used: false });
  });
  test("the rule by value: a preview shares its act; an act and its undo share; create ≠ edit", () => {
    expect(ROUTE_ACCESS["POST /courses/preview"]!.action).toBe(ROUTE_ACCESS["POST /courses"]!.action);
    expect(ROUTE_ACCESS["POST /courses/:id/cancel/preview"]!.action).toBe(ROUTE_ACCESS["POST /courses/:id/cancel"]!.action);
    expect(ROUTE_ACCESS["POST /bookings/:id/resume"]!.action).toBe(ROUTE_ACCESS["POST /bookings/:id/pause"]!.action);
    expect(ROUTE_ACCESS["POST /courses/:id/resume"]!.action).toBe(ROUTE_ACCESS["POST /courses/:id/drop"]!.action);
    expect(ROUTE_ACCESS["POST /parents/:id/unsuspend"]!.action).toBe(ROUTE_ACCESS["POST /parents/:id/suspend"]!.action);
    expect(ROUTE_ACCESS["POST /teachers/:id/reactivate"]!.action).toBe(ROUTE_ACCESS["POST /teachers/:id/archive"]!.action);
    expect(ROUTE_ACCESS["POST /teacher-link-requests/:id/reject"]!.action).toBe(ROUTE_ACCESS["POST /teacher-link-requests/:id/approve"]!.action);
    expect(ROUTE_ACCESS["POST /teachers"]!.action).not.toBe(ROUTE_ACCESS["PATCH /teachers/:id"]!.action);
    expect(ROUTE_ACCESS["POST /students"]!.action).toBe("action:people.student-create"); // the booking form creates inline; the ACT is a people act
    expect(ROUTE_ACCESS["PATCH /bookings/:id/status"]!.action).toBe("action:calendar.status"); // ONE key for its four body acts (confirmed)
    expect(ROUTE_ACCESS["DELETE /settings/:key"]!.action).toBe("action:settings.edit");
  });
  test("the file is `route-access.ts`; `route-menus.ts` and `ROUTE_MENUS` are gone", () => {
    expect(() => readFileSync(resolve(root, "src/lib/route-menus.ts"))).toThrow();
    expect(code(src("src/middleware/auth.ts"))).not.toContain("ROUTE_MENUS");
    expect(code(src("src/middleware/auth.ts"))).not.toContain("menuGuard");
  });
});

describe("🔴 the guard end to end — menu first, then the action with ITS OWN sentence (real middlewares, service spied)", () => {
  const ids = { sa: "11111111-1111-4111-8111-111111111111", cal: "22222222-2222-4222-8222-222222222222", booker: "33333333-3333-4333-8333-333333333333" };
  const rows: Record<string, any> = {
    [ids.sa]: { id: ids.sa, username: "boss", displayName: "Boss", isSuperAdmin: true, disabledAt: null },
    [ids.cal]: { id: ids.cal, username: "viewer", displayName: "Viewer", isSuperAdmin: false, disabledAt: null },
    [ids.booker]: { id: ids.booker, username: "booker", displayName: "Booker", isSuperAdmin: false, disabledAt: null },
  };
  const grants: Record<string, string[]> = { [ids.cal]: ["menu:calendar"], [ids.booker]: ["menu:calendar", "action:calendar.book"] };
  const spies = [
    spyOn(usersSvc, "findUserById").mockImplementation((async (id: string) => rows[id] ?? null) as any),
    spyOn(usersSvc, "userGrantKeys").mockImplementation((async (id: string) => grants[id] ?? []) as any),
  ];
  afterAll(() => spies.forEach((s) => s.mockRestore()));
  const origSkip = process.env.SKIP_AUTH;
  afterAll(() => { if (origSkip === undefined) delete process.env.SKIP_AUTH; else process.env.SKIP_AUTH = origSkip; });

  const app = () => {
    process.env.SKIP_AUTH = "false";
    const a = new Hono();
    a.use("/api/*", authMiddleware);
    a.use("/api/*", accessGuard);
    a.get("/api/calendar", (c) => c.json({ ok: "read" }));
    a.post("/api/bookings", (c) => c.json({ ok: "booked" }));
    a.patch("/api/bookings/:id/note", (c) => c.json({ ok: "noted" }));
    a.put("/api/settings/:key", (c) => c.json({ ok: "set" }));
    a.onError((err, c) => (err instanceof ApiException ? c.json({ error: err.code, message: err.message }, err.status as any) : c.json({ error: "INTERNAL" }, 500)));
    a.notFound((c) => c.json({ error: "NOT_FOUND" }, 404));
    return a;
  };
  const as = async (id: string) => ({ headers: { authorization: `Bearer ${await signToken({ sub: id, username: rows[id].username, role: "admin", isSuperAdmin: rows[id].isSuperAdmin })}` } });
  const hit = async (id: string, method: string, path: string) => app().request(path, { method, ...(await as(id)) });

  test("`menu:calendar` and NO action: reads the calendar (200) and gets 403 + THE ACTION SENTENCE on `POST /bookings`", async () => {
    expect((await hit(ids.cal, "GET", "/api/calendar")).status).toBe(200);
    const res = await hit(ids.cal, "POST", "/api/bookings");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "FORBIDDEN", message: "ไม่มีสิทธิ์ทำรายการนี้" });
  });
  test("with `action:calendar.book` ⇒ through; a DIFFERENT act on the same menu is still refused with the action sentence", async () => {
    expect((await hit(ids.booker, "POST", "/api/bookings")).status).toBe(200);
    const res = await hit(ids.booker, "PATCH", "/api/bookings/b-1/note");
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).message).toBe("ไม่มีสิทธิ์ทำรายการนี้");
  });
  test("🔴 the MENU check comes first: no menu ⇒ the MENU sentence, even when the action would fail too", async () => {
    const res = await hit(ids.booker, "PUT", "/api/settings/x");
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).message).toBe("ไม่มีสิทธิ์เข้าถึงเมนูนี้");
  });
  test("a super admin does all", async () => {
    for (const [m, p] of [["GET", "/api/calendar"], ["POST", "/api/bookings"], ["PATCH", "/api/bookings/b-1/note"], ["PUT", "/api/settings/x"]] as const) expect((await hit(ids.sa, m, p)).status).toBe(200);
  });
  test("`requireAction` as a primitive", async () => {
    process.env.SKIP_AUTH = "false";
    const a = new Hono();
    a.use("/x/*", authMiddleware);
    a.post("/x/r", requireAction("action:calendar.book"), (c) => c.json({ ok: true }));
    a.onError((err, c) => (err instanceof ApiException ? c.json({ error: err.code, message: err.message }, err.status as any) : c.json({ error: "INTERNAL" }, 500)));
    expect((await a.request("/x/r", { method: "POST", ...(await as(ids.cal)) })).status).toBe(403);
    expect((await a.request("/x/r", { method: "POST", ...(await as(ids.booker)) })).status).toBe(200);
    expect((await a.request("/x/r", { method: "POST", ...(await as(ids.sa)) })).status).toBe(200);
  });
});

describe("🔴 the two body-level acts", () => {
  test("`assertMayOverrideLeave`: no flag ⇒ nothing; the flag needs `action:calendar.leave-override` (403, its sentence); a super admin may", () => {
    const plain = { isSuperAdmin: false, grants: new Set(["action:calendar.status"]) };
    expect(() => assertMayOverrideLeave(undefined, plain)).not.toThrow();
    expect(() => assertMayOverrideLeave(false, plain)).not.toThrow();
    expect(() => assertMayOverrideLeave(true, plain)).toThrow("ไม่มีสิทธิ์ยกเว้นกฎแจ้งลาล่วงหน้า");
    expect(() => assertMayOverrideLeave(true, { isSuperAdmin: false, grants: new Set(["action:calendar.leave-override"]) })).not.toThrow();
    expect(() => assertMayOverrideLeave(true, { isSuperAdmin: true, grants: new Set() })).not.toThrow();
    try { assertMayOverrideLeave(true, plain); throw new Error("did not throw"); } catch (e: any) { expect(e.status).toBe(403); expect(e.code).toBe("FORBIDDEN"); }
  });
  test("the status route checks the flag BEFORE the service; the four creates check the discount (source)", () => {
    const API = code(src("src/routes/api.ts"));
    const status = API.slice(API.indexOf('.patch("/bookings/:id/status"'), API.indexOf("svc.updateBookingStatus("));
    expect(status).toContain('assertMayOverrideLeave(override, c.get("user"));');
    expect(API.match(/assertMayDiscount\(body\.discount, c\.get\("user"\)\);/g)!.length).toBe(4);
  });
});

describe("🔑 the routes — `/api/permissions`, `/api/me.actions`, `PUT /users/:id/actions` (root app; service spied)", () => {
  const app = rootApp;
  const spies: any[] = [];
  afterAll(() => spies.forEach((s) => s.mockRestore()));
  afterEach(() => { process.env.SKIP_AUTH = "true"; });

  test("GET /api/permissions ⇒ the registry; without a token ⇒ 401; a ZERO-grant user reads it (not menu-gated)", async () => {
    process.env.SKIP_AUTH = "true";
    const res = await app.fetch(new Request("http://localhost/api/permissions"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ menus: [...MENU_KEYS], actions: ACTION_REGISTRY.map((a) => ({ ...a })) });
    process.env.SKIP_AUTH = "false";
    expect((await app.fetch(new Request("http://localhost/api/permissions"))).status).toBe(401);
    const id = "44444444-4444-4444-8444-444444444444";
    const s1 = spyOn(usersSvc, "findUserById").mockImplementation((async () => ({ id, username: "nobody", displayName: "Nobody", isSuperAdmin: false, disabledAt: null })) as any);
    const s2 = spyOn(usersSvc, "userGrantKeys").mockImplementation((async () => []) as any);
    try {
      const token = await signToken({ sub: id, username: "nobody", role: "admin", isSuperAdmin: false });
      expect((await app.fetch(new Request("http://localhost/api/permissions", { headers: { authorization: `Bearer ${token}` } }))).status).toBe(200);
      const me = await app.fetch(new Request("http://localhost/api/me", { headers: { authorization: `Bearer ${token}` } }));
      expect(((await me.json()) as any).user.actions).toEqual([]);
    } finally { s1.mockRestore(); s2.mockRestore(); }
  });
  test("GET /api/me — a user's `actions` are their grants in registry order; the dev super admin has all 46", async () => {
    process.env.SKIP_AUTH = "true";
    const dev = await app.fetch(new Request("http://localhost/api/me"));
    expect(((await dev.json()) as any).user.actions).toEqual([...ACTION_KEYS]);
    process.env.SKIP_AUTH = "false";
    const id = "55555555-5555-4555-8555-555555555555";
    const s1 = spyOn(usersSvc, "findUserById").mockImplementation((async () => ({ id, username: "b", displayName: "B", isSuperAdmin: false, disabledAt: null })) as any);
    const s2 = spyOn(usersSvc, "userGrantKeys").mockImplementation((async () => ["action:settings.edit", "menu:calendar", "action:calendar.book"]) as any);
    try {
      const token = await signToken({ sub: id, username: "b", role: "admin", isSuperAdmin: false });
      const me = await app.fetch(new Request("http://localhost/api/me", { headers: { authorization: `Bearer ${token}` } }));
      expect(await me.json()).toEqual({ user: { id, username: "b", displayName: "B", isSuperAdmin: false, menus: ["menu:calendar"], actions: ["action:calendar.book", "action:settings.edit"] } });
    } finally { s1.mockRestore(); s2.mockRestore(); }
  });
  test("PUT /users/:id/actions { keys } ⇒ { user } with the new set; the actor from the token; unknown key ⇒ 400", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(usersSvc, "setUserActions").mockImplementation((async (id: string, keys: string[], actor: any) => {
      calls.push([id, keys, actor]);
      const bad = keys.filter((k) => !isActionKey(k));
      if (bad.length) throw new ApiException(400, "VALIDATION", `ไม่รู้จักรายการ: ${bad.join(", ")}`);
      return { id, username: "u", displayName: "U", isSuperAdmin: false, disabledAt: null, createdAt: "2026-09-18T00:00:00.000Z", menus: [], actions: keys };
    }) as any);
    spies.push(s);
    const put = (b: unknown) => app.fetch(new Request("http://localhost/api/users/u-1/actions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
    const res = await put({ keys: ["action:calendar.book", "action:sales.discount"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user.actions).toEqual(["action:calendar.book", "action:sales.discount"]);
    expect(calls.at(-1)).toEqual(["u-1", ["action:calendar.book", "action:sales.discount"], "dev"]);
    expect((await put({ keys: ["menu:calendar"] })).status).toBe(400); // a menu key is not an action
  });
});

describe("🔴 the service and the wiring (source)", () => {
  const SVC = code(src("src/services/user.service.ts"));
  test("`setUserActions` goes through the ONE `replaceGrants` with the `action:` prefix — the menus' rows untouched", () => {
    expect(SVC).toContain('return replaceGrants(id, keys, "action:", isActionKey, "ไม่รู้จักรายการ", actor);');
    const S = SVC.slice(SVC.indexOf("async function replaceGrants("), SVC.indexOf("\n}\n", SVC.indexOf("async function replaceGrants(")));
    expect(S).toContain("like(userPermissions.key, `${prefix}%`)");
    expect(S.indexOf("bad.length")).toBeLessThan(S.indexOf("db.transaction("));
    expect(S).toContain("[...new Set(keys)]");
  });
  test("the DTO derives `actions` (a super admin: all); the guard checks menu THEN action", () => {
    expect(SVC).toContain("actions: u.isSuperAdmin ? [...ACTION_KEYS] : ACTION_KEYS.filter((a) => new Set(grants).has(a)),");
    const MW = code(src("src/middleware/auth.ts"));
    const G = MW.slice(MW.indexOf("export async function accessGuard("));
    expect(G.indexOf("if (!hasMenu(user, ...access.menus)) throw MENU_FORBIDDEN();")).toBeLessThan(G.indexOf("if (access.action && !hasAction(user, access.action)) throw ACTION_FORBIDDEN();"));
  });
  test("37 = 37 — no migration", () => {
    expect(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8").match(/"tag"/g)!.length).toBe(37);
  });
});
