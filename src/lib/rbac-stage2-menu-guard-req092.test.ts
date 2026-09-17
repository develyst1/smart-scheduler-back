// TASK-381 (`REQ-092` RBAC, SPEC-079 Stage 2) — the `menu:*` registry, grants on the context, ONE table-driven
// `menuGuard` over every admin route (fail closed), `PUT /users/:id/menus`, `GET /auth/me`, the self password
// change. The enumeration below is TASK-185's shape extended from write routes to ALL routes: every route in
// `routes/api.ts` must have a `ROUTE_MENUS` entry and every entry must name a real route.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MENU_KEYS, hasMenu, isMenuKey, menusOf } from "./permissions";
import { ROUTE_MENUS, routeKey } from "./route-menus";
import { authMiddleware, menuGuard, requireMenu } from "../middleware/auth";
import { ApiException } from "./http";
import { signToken } from "./jwt";
import * as usersSvc from "../services/user.service";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

describe("🔑 the registry — 12 keys, one per nav entry, `users` is not a key", () => {
  test("the list", () => {
    expect([...MENU_KEYS]).toEqual(["menu:calendar", "menu:teachers", "menu:people", "menu:link-requests", "menu:bookings", "menu:badges", "menu:som", "menu:attention", "menu:reports", "menu:settings", "menu:dashboard", "menu:overview"]);
    expect(isMenuKey("menu:users")).toBe(false);
    expect(isMenuKey("action:sales.discount")).toBe(false);
  });
  test("`hasMenu`: a super admin has all; a user needs ANY of the listed; nobody ⇒ false", () => {
    const sa = { isSuperAdmin: true, grants: new Set<string>() };
    const cal = { isSuperAdmin: false, grants: new Set(["menu:calendar"]) };
    const none = { isSuperAdmin: false, grants: new Set<string>() };
    expect(hasMenu(sa, "menu:reports")).toBe(true);
    expect(hasMenu(cal, "menu:calendar")).toBe(true);
    expect(hasMenu(cal, "menu:reports")).toBe(false);
    expect(hasMenu(cal, "menu:reports", "menu:calendar")).toBe(true); // a shared read
    expect(hasMenu(none, "menu:calendar")).toBe(false);
    expect(hasMenu(null, "menu:calendar")).toBe(false);
  });
  test("`menusOf`: a super admin ⇒ all 12 in nav order; a user ⇒ their grants in nav order, non-menu keys ignored; none ⇒ []", () => {
    expect(menusOf({ isSuperAdmin: true, grants: new Set() })).toEqual([...MENU_KEYS]);
    expect(menusOf({ isSuperAdmin: false, grants: new Set(["menu:reports", "menu:calendar", "action:x"]) })).toEqual(["menu:calendar", "menu:reports"]);
    expect(menusOf({ isSuperAdmin: false, grants: new Set() })).toEqual([]);
  });
});

describe("🔴 the enumeration — every route in `routes/api.ts` has a ROUTE_MENUS entry, and every entry names a route", () => {
  const ROUTES = readSrc(readFileSync(resolve(root, "src/routes/api.ts"), "utf8"));
  // `c.get("user")` has the same shape as `.get("/path")` — a ROUTE path starts with `/`; that is the only filter.
  const declared = [...ROUTES.matchAll(/\.(get|post|patch|put|delete)\(\s*"(\/[^"]*)"/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
  test("the router declares 85 routes (the floor that keeps this list non-empty), and every one is mapped", () => {
    expect(declared.length).toBeGreaterThanOrEqual(85);
    const unmapped = declared.filter((r) => !(r in ROUTE_MENUS));
    expect(unmapped).toEqual([]);
  });
  test("no stale entry: every ROUTE_MENUS key is a declared route, and every entry lists ≥ 1 known menu", () => {
    const stale = Object.keys(ROUTE_MENUS).filter((k) => !declared.includes(k));
    expect(stale).toEqual([]);
    for (const [k, menus] of Object.entries(ROUTE_MENUS)) {
      expect({ k, ok: menus.length > 0 && menus.every(isMenuKey) }).toEqual({ k, ok: true });
    }
  });
  test("the shared reads carry several menus — the map is from the FE's calls, not one-route-one-menu", () => {
    expect([...ROUTE_MENUS["GET /teachers"]!].sort()).toEqual(["menu:bookings", "menu:calendar", "menu:link-requests", "menu:reports", "menu:teachers"]);
    expect([...ROUTE_MENUS["GET /bookings"]!].sort()).toEqual(["menu:bookings", "menu:calendar"]);
    expect([...ROUTE_MENUS["GET /badges"]!].sort()).toEqual(["menu:badges", "menu:calendar"]);
    expect(ROUTE_MENUS["GET /reports/daily"]).toEqual(["menu:reports"]);
    expect(ROUTE_MENUS["GET /calendar"]).toEqual(["menu:calendar"]);
  });
  test("`/auth/*` and `/users/*` are NOT in the table (login is public; users is `requireSuperAdmin`)", () => {
    expect(Object.keys(ROUTE_MENUS).some((k) => /\/(auth|users)(\/|$)/.test(k))).toBe(false);
    expect(routeKey("get", "/api/calendar")).toBe("GET /calendar");
  });
});

describe("🔴 the guard end to end — a calendar-only user, a super admin, a shared read, a zero-menu user (the service spied)", () => {
  const ids = { sa: "11111111-1111-4111-8111-111111111111", cal: "22222222-2222-4222-8222-222222222222", none: "33333333-3333-4333-8333-333333333333" };
  const rows: Record<string, any> = {
    [ids.sa]: { id: ids.sa, username: "boss", displayName: "Boss", isSuperAdmin: true, disabledAt: null },
    [ids.cal]: { id: ids.cal, username: "front", displayName: "Front", isSuperAdmin: false, disabledAt: null },
    [ids.none]: { id: ids.none, username: "nobody", displayName: "Nobody", isSuperAdmin: false, disabledAt: null },
  };
  const grantReads: string[] = [];
  const spies = [
    spyOn(usersSvc, "findUserById").mockImplementation((async (id: string) => rows[id] ?? null) as any),
    spyOn(usersSvc, "userGrantKeys").mockImplementation((async (id: string) => { grantReads.push(id); return id === ids.cal ? ["menu:calendar"] : []; }) as any),
  ];
  afterAll(() => spies.forEach((s) => s.mockRestore()));
  const origSkip = process.env.SKIP_AUTH;
  afterAll(() => { if (origSkip === undefined) delete process.env.SKIP_AUTH; else process.env.SKIP_AUTH = origSkip; });

  // a mini app with the REAL guards and a handful of routes shaped like api.ts's (same paths ⇒ same table rows)
  const app = () => {
    process.env.SKIP_AUTH = "false";
    const a = new Hono();
    a.use("/api/*", authMiddleware);
    a.use("/api/*", menuGuard);
    a.get("/api/calendar", (c) => c.json({ ok: "calendar" }));
    a.get("/api/teachers", (c) => c.json({ ok: "teachers" }));
    a.get("/api/reports/daily", (c) => c.json({ ok: "reports" }));
    a.get("/api/not-in-the-table", (c) => c.json({ ok: "leak" }));
    a.onError((err, c) => (err instanceof ApiException ? c.json({ error: err.code, message: err.message }, err.status as any) : c.json({ error: "INTERNAL" }, 500)));
    a.notFound((c) => c.json({ error: "NOT_FOUND" }, 404));
    return a;
  };
  const as = async (id: string) => ({ headers: { authorization: `Bearer ${await signToken({ sub: id, username: rows[id].username, role: "admin", isSuperAdmin: rows[id].isSuperAdmin })}` } });
  const status = async (id: string, path: string) => (await app().request(path, await as(id))).status;

  test("a user with `menu:calendar` reaches the calendar and the SHARED teachers read, and NOT reports (403, the menu sentence)", async () => {
    expect(await status(ids.cal, "/api/calendar")).toBe(200);
    expect(await status(ids.cal, "/api/teachers")).toBe(200); // shared: calendar OR teachers OR …
    const res = await app().request("/api/reports/daily", await as(ids.cal));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "FORBIDDEN", message: "ไม่มีสิทธิ์เข้าถึงเมนูนี้" });
  });
  test("a super admin reaches all — and the grants read is SKIPPED for them (Stage 1's single read)", async () => {
    grantReads.length = 0;
    for (const p of ["/api/calendar", "/api/teachers", "/api/reports/daily"]) expect(await status(ids.sa, p)).toBe(200);
    expect(grantReads).toEqual([]);
  });
  test("a zero-menu user is let IN (the token is fine) and refused on every menu route", async () => {
    expect(await status(ids.none, "/api/calendar")).toBe(403);
    expect(await status(ids.none, "/api/teachers")).toBe(403);
  });
  test("🔴 fails CLOSED: a route with no table entry is refused 403 for a normal user AND for a super admin — and logged", async () => {
    const logs: string[] = [];
    const s = spyOn(console, "error").mockImplementation(((...a: any[]) => { logs.push(a.join(" ")); }) as any);
    try {
      expect(await status(ids.cal, "/api/not-in-the-table")).toBe(403);
      expect(await status(ids.sa, "/api/not-in-the-table")).toBe(403);
      expect(logs.some((l) => l.includes("[rbac] route not in ROUTE_MENUS") && l.includes("GET /api/not-in-the-table"))).toBe(true);
    } finally { s.mockRestore(); }
  });
  test("an UNKNOWN path is the 404's business, not a menu refusal (TASK-297's envelope survives)", async () => {
    expect(await status(ids.cal, "/api/no-such-route")).toBe(404);
  });
  test("`requireMenu` as a primitive: the same rule, usable on a single route", async () => {
    process.env.SKIP_AUTH = "false";
    const a = new Hono();
    a.use("/x/*", authMiddleware);
    a.get("/x/r", requireMenu("menu:reports", "menu:som"), (c) => c.json({ ok: true }));
    a.onError((err, c) => (err instanceof ApiException ? c.json({ error: err.code }, err.status as any) : c.json({ error: "INTERNAL" }, 500)));
    expect((await a.request("/x/r", await as(ids.cal))).status).toBe(403);
    expect((await a.request("/x/r", await as(ids.sa))).status).toBe(200);
  });
});

const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };

describe("🔑 the routes — `/auth/me`, the self password change, `PUT /users/:id/menus` (root app; service spied)", () => {
  const app = rootApp;
  const calls: any[] = [];
  const spies: any[] = [];
  afterAll(() => spies.forEach((s) => s.mockRestore()));
  afterEach(() => { process.env.SKIP_AUTH = "true"; });

  test("GET /auth/me — the dev super admin ⇒ all 12 menus; the shape is the nav's fact", async () => {
    process.env.SKIP_AUTH = "true";
    const res = await app.fetch(new Request("http://localhost/api/auth/me"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: "dev", username: "dev", displayName: "dev", isSuperAdmin: true, menus: [...MENU_KEYS] } });
  });
  test("🔴 GET /auth/me WITHOUT a token ⇒ 401 — the `me` routes carry the JWT guard explicitly (auth is mounted before the guard); login stays public", async () => {
    process.env.SKIP_AUTH = "false";
    expect((await app.fetch(new Request("http://localhost/api/auth/me"))).status).toBe(401);
    expect((await app.fetch(new Request("http://localhost/api/auth/me/password", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status).toBe(401);
    const login = await app.fetch(new Request("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "x", password: "y" }) }));
    expect(login.status).not.toBe(401 + 1000); // reaches the handler (a 401 from authenticate, never the guard's)
  });
  test("a ZERO-menu user's /auth/me ⇒ `menus: []` (the shell's fact), not an error", async () => {
    process.env.SKIP_AUTH = "false";
    const id = "44444444-4444-4444-8444-444444444444";
    const s1 = spyOn(usersSvc, "findUserById").mockImplementation((async () => ({ id, username: "nobody", displayName: "Nobody", isSuperAdmin: false, disabledAt: null })) as any);
    const s2 = spyOn(usersSvc, "userGrantKeys").mockImplementation((async () => []) as any);
    try {
      const token = await signToken({ sub: id, username: "nobody", role: "admin", isSuperAdmin: false });
      const res = await app.fetch(new Request("http://localhost/api/auth/me", { headers: { authorization: `Bearer ${token}` } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ user: { id, username: "nobody", displayName: "Nobody", isSuperAdmin: false, menus: [] } });
    } finally { s1.mockRestore(); s2.mockRestore(); }
  });
  test("POST /auth/me/password ⇒ the service with the caller's OWN id; wrong current 401 / short 400 / ok { ok: true }", async () => {
    process.env.SKIP_AUTH = "true";
    const s = spyOn(usersSvc, "changeOwnPassword").mockImplementation((async (id: string, cur: string, next: string) => {
      calls.push(["pw", id, cur, next]);
      if (cur !== "old-pass-1") throw new ApiException(401, "UNAUTHORIZED", "รหัสผ่านปัจจุบันไม่ถูกต้อง");
      if (next.length < 8) throw new ApiException(400, "PASSWORD_TOO_SHORT", "x");
      return { ok: true as const };
    }) as any);
    spies.push(s);
    const post = (b: unknown) => app.fetch(new Request("http://localhost/api/auth/me/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
    expect((await post({ currentPassword: "wrong", newPassword: "new-pass-1" })).status).toBe(401);
    expect((await post({ currentPassword: "old-pass-1", newPassword: "short" })).status).toBe(400);
    const ok = await post({ currentPassword: "old-pass-1", newPassword: "new-pass-1" });
    expect(await ok.json()).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual(["pw", "dev", "old-pass-1", "new-pass-1"]);
  });
  test("PUT /users/:id/menus { keys } ⇒ { user } with the new set; the actor from the token; unknown key ⇒ 400", async () => {
    process.env.SKIP_AUTH = "true";
    const s = spyOn(usersSvc, "setUserMenus").mockImplementation((async (id: string, keys: string[], actor: any) => {
      calls.push(["menus", id, keys, actor]);
      const bad = keys.filter((k) => !isMenuKey(k));
      if (bad.length) throw new ApiException(400, "VALIDATION", `ไม่รู้จักเมนู: ${bad.join(", ")}`);
      return { id, username: "u", displayName: "U", isSuperAdmin: false, disabledAt: null, createdAt: "2026-09-17T00:00:00.000Z", menus: keys };
    }) as any);
    spies.push(s);
    const put = (b: unknown) => app.fetch(new Request("http://localhost/api/users/u-1/menus", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
    const res = await put({ keys: ["menu:calendar", "menu:reports"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user.menus).toEqual(["menu:calendar", "menu:reports"]);
    expect(calls.at(-1)).toEqual(["menus", "u-1", ["menu:calendar", "menu:reports"], "dev"]);
    expect((await put({ keys: ["menu:nope"] })).status).toBe(400);
  });
});

describe("🔴 the service and the wiring (source)", () => {
  const SVC = code(src("src/services/user.service.ts"));
  test("`setUserMenus` REPLACES: one transaction, delete `menu:%` rows, insert the deduplicated set; unknown key refused before any write", () => {
    const S = SVC.slice(SVC.indexOf("export async function setUserMenus("), SVC.indexOf("export async function changeOwnPassword("));
    expect(S).toContain("const bad = keys.filter((k) => !isMenuKey(k));");
    expect(S).toContain("db.transaction(async (tx) => {");
    expect(S).toContain('like(userPermissions.key, "menu:%")');
    expect(S).toContain("[...new Set(keys)]");
    expect(S.indexOf("bad.length")).toBeLessThan(S.indexOf("db.transaction("));
  });
  test("`changeOwnPassword`: verify the CURRENT hash (401) before the length rule (400), then replace the hash", () => {
    const S = SVC.slice(SVC.indexOf("export async function changeOwnPassword("), SVC.indexOf("\n}\n", SVC.indexOf("export async function changeOwnPassword(")));
    expect(S).toContain('if (!(await verifyPassword(currentPassword, row.passwordHash))) throw new ApiException(401, "UNAUTHORIZED", "รหัสผ่านปัจจุบันไม่ถูกต้อง");');
    expect(S.indexOf("verifyPassword(")).toBeLessThan(S.indexOf("assertPassword(newPassword)"));
    expect(S).toContain("passwordHash: await hashPassword(newPassword)");
  });
  test("`listUsers` reads grants in ONE grouped query; the DTO derives `menus` (a super admin: all)", () => {
    expect(SVC).toContain("const grants = await grantsByUser(rows.map((r) => r.id));");
    expect(SVC).toContain("menus: u.isSuperAdmin ? [...MENU_KEYS] : MENU_KEYS.filter((m) => new Set(grants).has(m)),");
  });
  test("the guard order in `index.ts`: auth → menuGuard → the users group; the grants read only for a non-super-admin", () => {
    const IDX = code(src("src/index.ts"));
    expect(IDX.indexOf('app.use("/api/*", authMiddleware);')).toBeLessThan(IDX.indexOf('app.use("/api/*", menuGuard);'));
    expect(IDX.indexOf('app.use("/api/*", menuGuard);')).toBeLessThan(IDX.indexOf('app.route("/api/users", userRoutes);'));
    expect(code(src("src/middleware/auth.ts"))).toContain("row.isSuperAdmin ? [] : await userGrantKeys(row.id)");
  });
  test("37 = 37 — no migration", () => {
    expect(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8").match(/"tag"/g)!.length).toBe(37);
  });
});
