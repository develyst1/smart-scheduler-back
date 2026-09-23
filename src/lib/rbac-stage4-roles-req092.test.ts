// TASK-387 (`REQ-092` RBAC, SPEC-079 Stage 4 — the finale) — roles: migration `0037` (38 = 38, counted, witnessed,
// the `users` lock named), a LIVE role (effective = role ∪ own), `/roles` CRUD, `PUT /users/:id/role`,
// `grants { fromRole, own }`, `/me.roleName`. The role and the user services are spied at the ROOT app; the pure
// rules (`toUserDTO`, `normalizeKeys`, `normalizeRoleName`) are asserted by value.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ACTION_KEYS, MENU_KEYS } from "./permissions";
import { authMiddleware, accessGuard, toAuthUser, DEV_USER } from "../middleware/auth";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { ApiException } from "./http";
import { signToken } from "./jwt";
import * as usersSvc from "../services/user.service";
import * as rolesSvc from "../services/role.service";
import { readSrc } from "./read-src";
import { uuidFor } from "./test-uuid";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a);
  return s.slice(a, b < 0 ? undefined : b);
};
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const ROW = { id: uuidFor("u-1"), username: "front", displayName: "Front", isSuperAdmin: false, disabledAt: null, createdAt: "2026-09-18T00:00:00Z" };
const ROLE = { id: uuidFor("r-1"), name: "Front desk", keys: ["menu:calendar", "action:calendar.book", "menu:bookings"] };

describe("🔴 the migration — 0037, counted, witnessed, the `users` lock named (source)", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const JOURNAL = readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8");
  const SQL = readFileSync(resolve(root, "drizzle/0037_roles.sql"), "utf8").replace(/\r\n/g, "\n");
  const body = SQL.replace(/^--.*$/gm, "");
  test("53 = 53 (0038 … 0052 added since): `0037_roles` is the 38th file, idx 37", () => {
    expect(files.length).toBe(53);
    expect(files[37]).toBe("0037_roles.sql");
    const j = JSON.parse(JOURNAL) as { entries: Array<{ idx: number; tag: string }> };
    expect(j.entries.length).toBe(53);
    expect(j.entries[37]).toMatchObject({ idx: 37, tag: "0037_roles" });
  });
  test("five statements in the contract's order: roles · lower(name) UNIQUE · users.role_id RESTRICT · role_permissions CASCADE · the (role_id, key) UNIQUE LAST; all IF NOT EXISTS", () => {
    expect((SQL.match(/--> statement-breakpoint/g) ?? []).length).toBe(4);
    const order = [
      'CREATE TABLE IF NOT EXISTS "roles"',
      'CREATE UNIQUE INDEX IF NOT EXISTS "roles_name_uq" ON "roles" (lower("name"))',
      'ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role_id" uuid NULL REFERENCES "roles"("id") ON DELETE RESTRICT',
      'CREATE TABLE IF NOT EXISTS "role_permissions"',
      '"role_id"     uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE',
      'CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_role_key_uq" ON "role_permissions" ("role_id", "key")',
    ];
    let at = -1;
    for (const s of order) { const i = body.indexOf(s); expect({ s, found: i > at }).toEqual({ s, found: true }); at = i; }
    expect(body.trim().endsWith('CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_role_key_uq" ON "role_permissions" ("role_id", "key");')).toBe(true);
    expect((body.match(/CREATE (TABLE|UNIQUE INDEX)|ALTER TABLE/g) ?? []).length).toBe(5);
    expect((body.match(/IF NOT EXISTS/g) ?? []).length).toBe(5);
  });
  test("the header names the ONE lock on an existing table (ACCESS EXCLUSIVE on `users`, catalog-only, no rewrite), the queueing hazard, and one run", () => {
    expect(SQL).toContain("takes **ACCESS EXCLUSIVE on\n--     `users`** for the duration of that ONE statement");
    expect(SQL).toContain("no table rewrite, no backfill");
    expect(SQL).toContain("The four other\n--     statements lock nothing existing");
    expect(SQL).toContain("a\n--     read-blocking blink on `users`");
    expect(SQL).toContain("ONE run, ONE transaction (drizzle runs each migration in a transaction), five statements");
    expect(SQL).toContain("`drizzle/*.sql` = 37 (0000–0036) and journal tags = 37 before this, newest `0036`, so this is `0037`");
  });
  test("🔑 the witness is the LAST object, `role_permissions_role_key_uq`, registered and rerunnable", () => {
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0037_roles")!; // 🔻 TASK-390: no longer last — found by tag
    expect(w).toMatchObject({ tag: "0037_roles", probe: { kind: "index", index: "role_permissions_role_key_uq" }, rerunnable: true });
    expect(w.why).toContain("LAST of five objects");
  });
  test("the schema mirrors it: `users.roleId` RESTRICT, `roles` with the lower(name) unique, `rolePermissions` CASCADE + the unique", () => {
    const S = code(src("src/db/schema.ts"));
    expect(S).toContain('roleId: uuid("role_id").references(() => roles.id, { onDelete: "restrict" }),');
    expect(S).toContain('uniqueIndex("roles_name_uq").on(sql`lower(${t.name})`)');
    expect(S).toContain('.references(() => roles.id, { onDelete: "cascade" }),');
    expect(S).toContain('uniqueIndex("role_permissions_role_key_uq").on(t.roleId, t.key)');
  });
});

describe("🔑 the rules — pure, with values", () => {
  test("`toUserDTO`: effective = role ∪ own, in registry order; `grants` keeps the split; `roleId`/`roleName` from the role; a super admin has all regardless", () => {
    const dto = usersSvc.toUserDTO(ROW, ["action:settings.edit", "menu:calendar"], ROLE);
    expect(dto.menus).toEqual(["menu:calendar", "menu:bookings"]);
    expect(dto.actions).toEqual(["action:calendar.book", "action:settings.edit"]);
    expect(dto.grants).toEqual({ fromRole: ROLE.keys, own: ["action:settings.edit", "menu:calendar"] });
    expect(dto.roleId).toBe(uuidFor("r-1"));
    expect(dto.roleName).toBe("Front desk");
    const none = usersSvc.toUserDTO(ROW, ["menu:reports"], null);
    expect(none).toMatchObject({ menus: ["menu:reports"], actions: [], roleId: null, roleName: null, grants: { fromRole: [], own: ["menu:reports"] } });
    const sa = usersSvc.toUserDTO({ ...ROW, isSuperAdmin: true }, [], ROLE);
    expect(sa.menus).toEqual([...MENU_KEYS]);
    expect(sa.actions).toEqual([...ACTION_KEYS]);
    expect(sa.roleName).toBe("Front desk"); // the role is shown, even though it does not limit them
  });
  test("🔴 a role's key is EFFECTIVE without being OWN — the split is what the checklists render as inherited vs own", () => {
    const dto = usersSvc.toUserDTO(ROW, [], ROLE);
    expect(dto.menus).toEqual(["menu:calendar", "menu:bookings"]);
    expect(dto.grants.own).toEqual([]);
    expect(dto.grants.fromRole).toContain("menu:calendar");
  });
  test("`normalizeKeys`: unknown ⇒ 400 with the key named; duplicates collapse; registry order (menus, then actions)", () => {
    expect(rolesSvc.normalizeKeys(["action:calendar.book", "menu:calendar", "menu:calendar"])).toEqual(["menu:calendar", "action:calendar.book"]);
    expect(rolesSvc.normalizeKeys([])).toEqual([]);
    try { rolesSvc.normalizeKeys(["menu:calendar", "menu:users"]); throw new Error("did not throw"); } catch (e: any) { expect(e.status).toBe(400); expect(e.message).toBe("ไม่รู้จักสิทธิ์: menu:users"); }
    expect(rolesSvc.ALL_KEYS).toEqual([...MENU_KEYS, ...ACTION_KEYS]);
  });
  test("`normalizeRoleName`: trimmed; blank ⇒ 400; > 60 ⇒ 400", () => {
    expect(rolesSvc.normalizeRoleName("  Front desk ")).toBe("Front desk");
    expect(() => rolesSvc.normalizeRoleName("   ")).toThrow("กรุณาระบุชื่อบทบาท");
    expect(() => rolesSvc.normalizeRoleName("x".repeat(61))).toThrow(/60/);
    expect(rolesSvc.normalizeRoleName("x".repeat(60))).toHaveLength(60);
  });
  test("`ROLE_IN_USE` carries the count in the sentence", () => {
    const e = rolesSvc.ROLE_IN_USE(3);
    expect(e.status).toBe(409);
    expect(e.code).toBe("ROLE_IN_USE");
    expect(e.message).toBe("มีผู้ใช้ 3 คนถืออยู่ — ย้ายก่อนลบ");
  });
  test("`toAuthUser` carries `roleId` (null when the row has none); `DEV_USER` has none", () => {
    expect(toAuthUser({ ...ROW, roleId: uuidFor("r-1") }, ["menu:calendar"]).roleId).toBe(uuidFor("r-1"));
    expect(toAuthUser(ROW).roleId).toBeNull();
    expect(DEV_USER.roleId).toBeNull();
  });
});

describe("🔴 the guard reads EFFECTIVE grants — a role's key lets a holder through; editing the role is seen at the next request (real middlewares, service spied)", () => {
  const ids = { holder: "22222222-2222-4222-8222-222222222222", sa: "11111111-1111-4111-8111-111111111111" };
  const rows: Record<string, any> = {
    [ids.holder]: { id: ids.holder, username: "front", displayName: "Front", isSuperAdmin: false, disabledAt: null, roleId: uuidFor("r-1") },
    [ids.sa]: { id: ids.sa, username: "boss", displayName: "Boss", isSuperAdmin: true, disabledAt: null, roleId: null },
  };
  const roleKeys: string[] = ["menu:calendar"]; // the LIVE role — mutated between requests below
  const reads: Array<[string, string | null | undefined]> = [];
  const spies = [
    spyOn(usersSvc, "findUserById").mockImplementation((async (id: string) => rows[id] ?? null) as any),
    // the effective read, as the real one would answer: own rows ∪ the role's rows
    spyOn(usersSvc, "effectiveGrantKeys").mockImplementation((async (id: string, roleId: string | null) => { reads.push([id, roleId]); return [...new Set([...(id === ids.holder ? ["action:calendar.note"] : []), ...(roleId === uuidFor("r-1") ? roleKeys : [])])]; }) as any),
  ];
  afterAll(() => spies.forEach((s) => s.mockRestore()));
  const origSkip = process.env.SKIP_AUTH;
  afterAll(() => { if (origSkip === undefined) delete process.env.SKIP_AUTH; else process.env.SKIP_AUTH = origSkip; });
  const app = () => {
    process.env.SKIP_AUTH = "false";
    const a = new Hono();
    a.use("/api/*", authMiddleware);
    a.use("/api/*", accessGuard);
    a.get("/api/calendar", (c) => c.json({ ok: true }));
    a.post("/api/bookings", (c) => c.json({ ok: true }));
    a.patch("/api/bookings/:id/note", (c) => c.json({ ok: true }));
    a.onError((err, c) => (err instanceof ApiException ? c.json({ error: err.code, message: err.message }, err.status as any) : c.json({ error: "INTERNAL" }, 500)));
    return a;
  };
  const hit = async (id: string, method: string, path: string) => app().request(path, { method, headers: { authorization: `Bearer ${await signToken({ sub: id, username: rows[id].username, role: "admin", isSuperAdmin: rows[id].isSuperAdmin })}` } });

  test("the guard calls the effective read with (id, roleId) from the ROW; the role's menu lets the holder in; the own action too; a key in neither ⇒ 403", async () => {
    reads.length = 0;
    expect((await hit(ids.holder, "GET", "/api/calendar")).status).toBe(200);
    expect(reads).toEqual([[ids.holder, uuidFor("r-1")]]);
    expect((await hit(ids.holder, "PATCH", `/api/bookings/${uuidFor("b-1")}/note`)).status).toBe(200); // own row
    expect((await hit(ids.holder, "POST", "/api/bookings")).status).toBe(403); // in neither
  });
  test("🔴 LIVE: the role gains `action:calendar.book` ⇒ the holder's NEXT request is through; it loses it ⇒ 403 again — no propagation, no new token", async () => {
    roleKeys.push("action:calendar.book");
    expect((await hit(ids.holder, "POST", "/api/bookings")).status).toBe(200);
    roleKeys.pop();
    expect((await hit(ids.holder, "POST", "/api/bookings")).status).toBe(403);
  });
  test("a super admin skips the read entirely", async () => {
    reads.length = 0;
    expect((await hit(ids.sa, "POST", "/api/bookings")).status).toBe(200);
    expect(reads).toEqual([]);
  });
});

describe("🔑 the routes — `/roles` CRUD (super admin), `PUT /users/:id/role`, `/me.roleName` (root app; services spied)", () => {
  const app = rootApp;
  const spies: any[] = [];
  afterAll(() => spies.forEach((s) => s.mockRestore()));
  afterEach(() => { process.env.SKIP_AUTH = "true"; });
  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const roleDTO = { id: uuidFor("r-1"), name: "Front desk", description: null, keys: ["menu:calendar"], userCount: 2, createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z" };

  test("GET /roles ⇒ { roles }; POST ⇒ 201 { role } with the actor; PATCH ⇒ { role }; DELETE ⇒ { deleted: true } | 409 ROLE_IN_USE with the count", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    spies.push(
      spyOn(rolesSvc, "listRoles").mockImplementation((async () => [roleDTO]) as any),
      spyOn(rolesSvc, "createRole").mockImplementation((async (input: any, actor: any) => { calls.push(["create", input, actor]); return roleDTO; }) as any),
      spyOn(rolesSvc, "updateRole").mockImplementation((async (id: string, input: any, actor: any) => { calls.push(["update", id, input, actor]); return { ...roleDTO, ...input }; }) as any),
      spyOn(rolesSvc, "deleteRole").mockImplementation((async (id: string) => { if (id === uuidFor("r-1")) throw rolesSvc.ROLE_IN_USE(2); return { deleted: true as const }; }) as any),
    );
    expect(await (await json("GET", "/api/roles")).json()).toEqual({ roles: [roleDTO] });
    const created = await json("POST", "/api/roles", { name: "Front desk", keys: ["menu:calendar"] });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ role: roleDTO });
    expect(calls.at(-1)).toEqual(["create", { name: "Front desk", keys: ["menu:calendar"] }, "dev"]);
    const patched = await json("PATCH", `/api/roles/${uuidFor("r-1")}`, { keys: ["menu:calendar", "action:calendar.book"] });
    expect(((await patched.json()) as any).role.keys).toEqual(["menu:calendar", "action:calendar.book"]);
    expect(calls.at(-1)).toEqual(["update", uuidFor("r-1"), { keys: ["menu:calendar", "action:calendar.book"] }, "dev"]);
    const inUse = await json("DELETE", `/api/roles/${uuidFor("r-1")}`);
    expect(inUse.status).toBe(409);
    expect(await inUse.json()).toEqual({ error: { code: "ROLE_IN_USE", message: "มีผู้ใช้ 2 คนถืออยู่ — ย้ายก่อนลบ" } });
    expect(await (await json("DELETE", `/api/roles/${uuidFor("r-2")}`)).json()).toEqual({ deleted: true });
  });
  test("🔴 `/roles` is super admin only and JWT-gated: no token ⇒ 401; a non-super-admin ⇒ 403 (its sentence) — never the access table's", async () => {
    process.env.SKIP_AUTH = "false";
    expect((await json("GET", "/api/roles")).status).toBe(401);
    const id = "44444444-4444-4444-8444-444444444444";
    const s1 = spyOn(usersSvc, "findUserById").mockImplementation((async () => ({ id, username: "front", displayName: "Front", isSuperAdmin: false, disabledAt: null, roleId: null })) as any);
    const s2 = spyOn(usersSvc, "effectiveGrantKeys").mockImplementation((async () => [...MENU_KEYS, ...ACTION_KEYS]) as any); // every grant — still not a super admin
    try {
      const token = await signToken({ sub: id, username: "front", role: "admin", isSuperAdmin: false });
      const res = await json("GET", "/api/roles", undefined, { authorization: `Bearer ${token}` });
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).error.message).toBe("เฉพาะผู้ดูแลระบบสูงสุดเท่านั้น");
    } finally { s1.mockRestore(); s2.mockRestore(); }
  });
  test("PUT /users/:id/role { roleId } ⇒ { user } with roleId/roleName/grants; { roleId: null } detaches; a missing body field ⇒ 400", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(usersSvc, "setUserRole").mockImplementation((async (id: string, roleId: string | null) => {
      calls.push([id, roleId]);
      return usersSvc.toUserDTO({ ...ROW, id }, ["menu:reports"], roleId ? ROLE : null);
    }) as any);
    spies.push(s);
    const res = await json("PUT", `/api/users/${uuidFor("u-1")}/role`, { roleId: uuidFor("r-1") });
    expect(res.status).toBe(200);
    const user = ((await res.json()) as any).user;
    expect(user).toMatchObject({ roleId: uuidFor("r-1"), roleName: "Front desk", menus: ["menu:calendar", "menu:bookings", "menu:reports"], grants: { fromRole: ROLE.keys, own: ["menu:reports"] } });
    const detached = ((await (await json("PUT", `/api/users/${uuidFor("u-1")}/role`, { roleId: null })).json()) as any).user;
    expect(detached).toMatchObject({ roleId: null, roleName: null, menus: ["menu:reports"], grants: { fromRole: [], own: ["menu:reports"] } });
    expect(calls).toEqual([[uuidFor("u-1"), uuidFor("r-1")], [uuidFor("u-1"), null]]);
    expect((await json("PUT", `/api/users/${uuidFor("u-1")}/role`, {})).status).toBe(400);
  });
  test("GET /api/me ⇒ + `roleName` (the header's fact): the holder's role name; null for none; the dev super admin null — and NO role read when the row has no role", async () => {
    process.env.SKIP_AUTH = "true";
    const nameReads: any[] = [];
    const sName = spyOn(rolesSvc, "roleNameOf").mockImplementation((async (roleId: any) => { nameReads.push(roleId); return roleId === uuidFor("r-1") ? "Front desk" : null; }) as any);
    spies.push(sName);
    expect(((await (await json("GET", "/api/me")).json()) as any).user.roleName).toBeNull();
    process.env.SKIP_AUTH = "false";
    const id = "55555555-5555-4555-8555-555555555555";
    const s1 = spyOn(usersSvc, "findUserById").mockImplementation((async () => ({ id, username: "front", displayName: "Front", isSuperAdmin: false, disabledAt: null, roleId: uuidFor("r-1") })) as any);
    const s2 = spyOn(usersSvc, "effectiveGrantKeys").mockImplementation((async () => ["menu:calendar"]) as any);
    try {
      const token = await signToken({ sub: id, username: "front", role: "admin", isSuperAdmin: false });
      const me = await json("GET", "/api/me", undefined, { authorization: `Bearer ${token}` });
      expect(await me.json()).toEqual({ user: { id, username: "front", displayName: "Front", isSuperAdmin: false, menus: ["menu:calendar"], actions: [], roleName: "Front desk", teacherId: null } });
      expect(nameReads).toEqual([null, uuidFor("r-1")]);
    } finally { s1.mockRestore(); s2.mockRestore(); }
    // the real `roleNameOf` issues no query for a null id (it would need a DB otherwise)
    sName.mockRestore(); spies.pop();
    expect(await rolesSvc.roleNameOf(null)).toBeNull();
    expect(await rolesSvc.roleNameOf(undefined)).toBeNull();
  });
});

describe("🔴 the services and the wiring (source)", () => {
  const USR = code(src("src/services/user.service.ts"));
  const ROL = code(src("src/services/role.service.ts"));
  test("`effectiveGrantKeys`: own rows UNION the role's rows in ONE statement; own alone without a role; the guard calls it with the row's roleId; a super admin skips it", () => {
    const S = region(USR, "export async function effectiveGrantKeys(", "\n}\n");
    expect(S).toContain("? await union(own, exec.select({ key: rolePermissions.key }).from(rolePermissions).where(eq(rolePermissions.roleId, roleId)))");
    expect(S).toContain(": await own;");
    expect(code(src("src/middleware/auth.ts"))).toContain('c.set("user", toAuthUser(row, row.isSuperAdmin ? [] : await effectiveGrantKeys(row.id, row.roleId)));');
  });
  test("`setUserRole`: unknown role ⇒ 404 before the write; writes ONLY `role_id`; own rows untouched (no delete of user_permissions in it)", () => {
    const S = region(USR, "export async function setUserRole(", "\n}\n");
    expect(S).toContain('if (roleId !== null && !(await findRole(roleId))) throw notFound("ไม่พบบทบาท");');
    expect(S).toContain("await db.update(users).set({ roleId }).where(eq(users.id, id));");
    expect(S).not.toContain("userPermissions");
    expect(S.indexOf("findRole(roleId)")).toBeLessThan(S.indexOf("db.update(users)"));
  });
  test("🚫 the menu/action writers never touch the role: `replaceGrants` writes `user_permissions` only", () => {
    const S = region(USR, "async function replaceGrants(", "\n}\n");
    expect(S).not.toContain("roleId");
    expect(S).not.toContain("rolePermissions");
    expect(S).toContain("tx.delete(userPermissions)");
  });
  test("`listUsers`: the users with their role, own rows grouped, the listed roles' keys grouped — three reads, none per user", () => {
    const S = region(USR, "export async function listUsers(", "\n}\n");
    expect(S).toContain("with: { role: true, teacher: true }"); // 🔻 TASK-406: + the linked teacher (one relation, still three reads)
    expect(S).toContain("const [grants, roleKeys] = await Promise.all([grantsByUser(rows.map((r) => r.id)), roleKeysByIds(roleIds)]);");
    expect((S.match(/await /g) ?? []).length).toBe(2);
  });
  test("`createRole` / `updateRole`: keys refused BEFORE the transaction; one tx; keys REPLACE (delete then insert); 23505 ⇒ ROLE_NAME_TAKEN", () => {
    const C = region(ROL, "export async function createRole(", "\n}\n");
    // 🔻 mutation I passed first: an absent call has indexOf -1, which is "before" anything — assert presence FIRST
    expect(C).toContain("const keys = normalizeKeys(input.keys);");
    expect(C.indexOf("normalizeKeys(input.keys)")).toBeLessThan(C.indexOf("db.transaction("));
    expect(C).toContain('if (pgErrorCode(e) === "23505") throw ROLE_NAME_TAKEN();');
    const U = region(ROL, "export async function updateRole(", "\n}\n");
    expect(U).toContain("const keys = input.keys === undefined ? undefined : normalizeKeys(input.keys);");
    expect(U.indexOf("normalizeKeys(input.keys)")).toBeLessThan(U.indexOf("db.transaction("));
    expect(U).toContain("await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));");
    expect(U).toContain("if (keys.length) await tx.insert(rolePermissions).values(keys.map((key) => ({ roleId: id, key, grantedBy: actor })));");
    expect(U.indexOf("tx.delete(rolePermissions)")).toBeLessThan(U.indexOf("tx.insert(rolePermissions)"));
    expect(U).toContain('if (pgErrorCode(e) === "23505") throw ROLE_NAME_TAKEN();');
  });
  test("`deleteRole`: counts holders FIRST ⇒ 409 with the count; then deletes; a 23503 from the FK ⇒ the same 409 with a fresh count", () => {
    const D = region(ROL, "export async function deleteRole(", "\n}\n");
    expect(D).toContain("const holders = await holderCount(id);\n  if (holders > 0) throw ROLE_IN_USE(holders);");
    expect(D.indexOf("holderCount(id)")).toBeLessThan(D.indexOf("db.delete(roles)"));
    expect(D).toContain('if (pgErrorCode(e) === "23503") throw ROLE_IN_USE(await holderCount(id));');
  });
  test("the wiring: `/api/roles` after the guard with `requireSuperAdmin`; `/roles` excluded from the access table", () => {
    const IDX = code(src("src/index.ts"));
    expect(IDX.indexOf('app.use("/api/*", accessGuard);')).toBeLessThan(IDX.indexOf('app.route("/api/roles", roleRoutes);'));
    expect(code(src("src/routes/roles.ts"))).toContain('.use("*", requireSuperAdmin)');
    expect(code(src("src/middleware/auth.ts"))).toContain("(auth|users|me|permissions|roles)(\\/|$)/.test(path)) return next();");
  });
});
