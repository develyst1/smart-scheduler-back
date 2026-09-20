// TASK-377 (`REQ-092` RBAC, SPEC-079 Stage 1) — real users: the table (migration `0036`, 37 = 37), `Bun.password`,
// login against the table with the first super admin bootstrapped at the FIRST LOGIN while the table is empty,
// the guard loading the row, `actorOf` = username at every site, user CRUD / reset / disable (super admin only),
// `LAST_SUPER_ADMIN`. Rules are pinned with values; routes through the ROOT app with the service spied; the
// bootstrap with the reads spied; the migration, the witness and the retired env login at the source.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { readSrc } from "./read-src";
import * as v from "../validation";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.SKIP_AUTH = "true";
process.env.JWT_SECRET ??= "test-secret";

const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return s.slice(a, b);
};

const usersSvc = await import("../services/user.service");
const app = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const { ApiException } = await import("./http");

describe("🔑 the rules — pure, with values", () => {
  test("username: trimmed + lower-cased; `^[a-z0-9._-]{3,40}$`", () => {
    expect(usersSvc.normalizeUsername("  Admin.One ")).toBe("admin.one");
    for (const ok of ["abc", "a.b_c-d", "x".repeat(40), "user01"]) expect(usersSvc.USERNAME_RE.test(ok)).toBe(true);
    for (const bad of ["ab", "x".repeat(41), "has space", "ไทย", "UPPER", "a@b"]) expect(usersSvc.USERNAME_RE.test(bad)).toBe(false);
  });
  test("password: min 8, nothing else (§3.2); shorter ⇒ 400 PASSWORD_TOO_SHORT", () => {
    expect(() => usersSvc.assertPassword("12345678")).not.toThrow();
    expect(() => usersSvc.assertPassword("aaaaaaaaaaaaaaaa")).not.toThrow(); // no complexity rule
    const e = (() => { try { usersSvc.assertPassword("1234567"); } catch (x) { return x as InstanceType<typeof ApiException>; } })()!;
    expect(e).toBeInstanceOf(ApiException);
    expect([e.status, e.code]).toEqual([400, "PASSWORD_TOO_SHORT"]);
    expect(usersSvc.PASSWORD_MIN).toBe(8);
  });
  test("🔴 LAST_SUPER_ADMIN: the last ENABLED super admin cannot be disabled or demoted — himself included; a disabled one, a plain admin, or one with a peer can", () => {
    expect(usersSvc.wouldRemoveLastSuperAdmin({ isSuperAdmin: true, disabledAt: null }, 0)).toBe(true);
    expect(usersSvc.wouldRemoveLastSuperAdmin({ isSuperAdmin: true, disabledAt: null }, 1)).toBe(false);
    expect(usersSvc.wouldRemoveLastSuperAdmin({ isSuperAdmin: false, disabledAt: null }, 0)).toBe(false);
    expect(usersSvc.wouldRemoveLastSuperAdmin({ isSuperAdmin: true, disabledAt: new Date() }, 0)).toBe(false); // already off — nothing to lose
  });
  test("the DTO never carries the hash", () => {
    const dto = usersSvc.toUserDTO({ id: "u", username: "a", displayName: "A", isSuperAdmin: false, disabledAt: null, createdAt: "2026-09-17T00:00:00Z", passwordHash: "x" } as any);
    expect(Object.keys(dto).sort()).toEqual(["actions", "createdAt", "disabledAt", "displayName", "grants", "id", "isSuperAdmin", "menus", "roleId", "roleName", "teacherId", "teacherName", "username"]); // 🔻 TASK-406: + teacherId/teacherName (never the hash) // 🔻 TASK-381: + menus; 🔻 TASK-385: + actions; 🔻 TASK-387: + roleId, roleName, grants
  });
  test("`Bun.password` round-trips (argon2id) and a wrong password fails", async () => {
    const h = await usersSvc.hashPassword("correct horse");
    expect(h.startsWith("$argon2")).toBe(true);
    expect(await usersSvc.verifyPassword("correct horse", h)).toBe(true);
    expect(await usersSvc.verifyPassword("wrong", h)).toBe(false);
  });
  test("the validators: shape only — the rules above live in the service", () => {
    expect(v.createUser.safeParse({ username: "x", password: "", displayName: "X" }).success).toBe(true); // the service refuses both
    expect(v.createUser.safeParse({ username: "", password: "12345678", displayName: "X" }).success).toBe(false);
    expect(v.updateUser.safeParse({}).success).toBe(true);
    expect(v.resetPassword.safeParse({ password: "short" }).success).toBe(true);
  });
});

describe("🔑 the bootstrap — at the FIRST LOGIN, only while the table is EMPTY, only with the env pair", () => {
  const env = { ...process.env };
  afterEach(() => { process.env.BOOTSTRAP_ADMIN_USERNAME = env.BOOTSTRAP_ADMIN_USERNAME; process.env.BOOTSTRAP_ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD; });
  const withSpies = async (count: number, fn: (created: any[]) => Promise<void>) => {
    const created: any[] = [];
    const s1 = spyOn(usersSvc, "countUsers").mockImplementation((async () => count) as any);
    const s2 = spyOn(usersSvc, "createUser").mockImplementation((async (input: any, actor: any) => { created.push([input, actor]); return {} as any; }) as any);
    try { await fn(created); } finally { s1.mockRestore(); s2.mockRestore(); }
  };
  test("empty table + the pair ⇒ the super admin is created by `bootstrap`; the env username is normalised", async () => {
    process.env.BOOTSTRAP_ADMIN_USERNAME = "Boss"; process.env.BOOTSTRAP_ADMIN_PASSWORD = "bootstrap-pass";
    await withSpies(0, async (created) => {
      expect(await usersSvc.bootstrapIfEmpty("boss", "bootstrap-pass")).toBe(true);
      expect(created).toEqual([[{ username: "Boss", password: "bootstrap-pass", displayName: "Boss", isSuperAdmin: true }, "bootstrap"]]);
    });
  });
  test("NON-empty table + the pair ⇒ ignored, nothing created (the pair is dead once a user exists)", async () => {
    process.env.BOOTSTRAP_ADMIN_USERNAME = "boss"; process.env.BOOTSTRAP_ADMIN_PASSWORD = "bootstrap-pass";
    await withSpies(3, async (created) => {
      expect(await usersSvc.bootstrapIfEmpty("boss", "bootstrap-pass")).toBe(false);
      expect(created).toEqual([]);
    });
  });
  test("empty table + the WRONG pair ⇒ nothing created; no pair in the env ⇒ nothing, ever", async () => {
    process.env.BOOTSTRAP_ADMIN_USERNAME = "boss"; process.env.BOOTSTRAP_ADMIN_PASSWORD = "bootstrap-pass";
    await withSpies(0, async (created) => {
      expect(await usersSvc.bootstrapIfEmpty("boss", "nope")).toBe(false);
      expect(await usersSvc.bootstrapIfEmpty("other", "bootstrap-pass")).toBe(false);
      expect(created).toEqual([]);
    });
    delete process.env.BOOTSTRAP_ADMIN_USERNAME; delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    await withSpies(0, async (created) => {
      expect(await usersSvc.bootstrapIfEmpty("boss", "bootstrap-pass")).toBe(false);
      expect(created).toEqual([]);
    });
  });
  test("`authenticate` runs the bootstrap first, then reads the row; disabled ⇒ null like unknown and wrong", async () => {
    const SVC = code(src("src/services/user.service.ts"));
    const A = region(SVC, "export async function authenticate(", "\n}\n");
    expect(A.indexOf("await bootstrapIfEmpty(username, password);")).toBeLessThan(A.indexOf("findUserByUsername(username)"));
    expect(A).toContain("if (!row) return null;");
    expect(A).toContain("if (!(await verifyPassword(password, row.passwordHash))) return null;");
    expect(A).toContain("if (row.disabledAt) return null;");
  });
});

describe("🔑 the routes — super admin only, through the ROOT app (the dev user is a super admin)", () => {
  const calls: any[] = [];
  // ⚠️ Installed in beforeAll, not at describe level: the bootstrap block above spies + restores `createUser`
  // inside its tests, and a restore there would wipe a spy installed here at collection time.
  let spies: any[] = [];
  beforeAll(() => { spies = [
    spyOn(usersSvc, "listUsers").mockImplementation((async () => [{ id: "u-1", username: "admin", displayName: "Admin", isSuperAdmin: true, disabledAt: null, createdAt: "2026-09-17T00:00:00.000Z" }]) as any),
    spyOn(usersSvc, "createUser").mockImplementation((async (input: any, actor: any) => {
      calls.push(["create", input, actor]);
      if (input.username === "taken") throw new ApiException(409, "USERNAME_TAKEN", "x");
      return { id: "u-2", username: input.username, displayName: input.displayName, isSuperAdmin: !!input.isSuperAdmin, disabledAt: null, createdAt: "2026-09-17T00:00:00.000Z" };
    }) as any),
    spyOn(usersSvc, "updateUser").mockImplementation((async (id: string, input: any) => { calls.push(["update", id, input]); if (id === "last") throw new ApiException(409, "LAST_SUPER_ADMIN", "x"); return { id, username: "x", displayName: input.displayName ?? "x", isSuperAdmin: !!input.isSuperAdmin, disabledAt: null, createdAt: "2026-09-17T00:00:00.000Z" }; }) as any),
    spyOn(usersSvc, "resetPassword").mockImplementation((async (id: string, pw: string) => { calls.push(["reset", id, pw]); if (pw.length < 8) throw new ApiException(400, "PASSWORD_TOO_SHORT", "x"); return { ok: true as const }; }) as any),
    spyOn(usersSvc, "setUserDisabled").mockImplementation((async (id: string, d: boolean) => { calls.push(["disabled", id, d]); if (id === "last" && d) throw new ApiException(409, "LAST_SUPER_ADMIN", "x"); return { id, username: "x", displayName: "x", isSuperAdmin: false, disabledAt: d ? "2026-09-17T00:00:00.000Z" : null, createdAt: "2026-09-17T00:00:00.000Z" }; }) as any),
  ]; });
  afterAll(() => spies.forEach((s) => s.mockRestore()));
  const req = (path: string, method = "GET", body?: unknown) =>
    app.fetch(new Request(`http://localhost/api/users${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));

  test("GET /users ⇒ { users } — no hash anywhere in the body", async () => {
    const res = await req("");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).users[0].username).toBe("admin");
    expect(text).not.toMatch(/passwordHash|password_hash|\$argon2/);
  });
  test("POST /users ⇒ 201 { user }, the actor from the token; USERNAME_TAKEN ⇒ 409", async () => {
    const res = await req("", "POST", { username: "new.user", password: "12345678", displayName: "New" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).user).toMatchObject({ username: "new.user", isSuperAdmin: false });
    expect(calls.at(-1)).toEqual(["create", { username: "new.user", password: "12345678", displayName: "New" }, "dev"]);
    const dup = await req("", "POST", { username: "taken", password: "12345678", displayName: "T" });
    expect([dup.status, ((await dup.json()) as any).error.code]).toEqual([409, "USERNAME_TAKEN"]);
  });
  test("PATCH / password / disable / enable — and LAST_SUPER_ADMIN, PASSWORD_TOO_SHORT reach the client as 409 / 400", async () => {
    expect((await req("/u-2", "PATCH", { displayName: "Renamed" })).status).toBe(200);
    expect(((await (await req("/last", "PATCH", { isSuperAdmin: false })).json()) as any).error.code).toBe("LAST_SUPER_ADMIN");
    expect(await (await req("/u-2/password", "POST", { password: "longenough" })).json()).toEqual({ ok: true });
    expect((await req("/u-2/password", "POST", { password: "short" })).status).toBe(400);
    expect(((await (await req("/u-2/disable", "POST")).json()) as any).user.disabledAt).not.toBeNull();
    expect((await req("/last/disable", "POST")).status).toBe(409);
    expect(((await (await req("/u-2/enable", "POST")).json()) as any).user.disabledAt).toBeNull();
  });
  test("🚫 no DELETE /users/:id — disable is the off switch", async () => {
    expect((await req("/u-2", "DELETE")).status).toBe(404);
  });
});

describe("🔴 the source — actor = username everywhere, the env login retired, the guard, the migration", () => {
  test("🔑 zero `.sub` actors: every actor site in the router is `actorOf(c)` — 14 of them — and no route reads `c.get(\"user\")?.sub`", () => {
    const API = code(src("src/routes/api.ts"));
    expect((API.match(/actorOf\(c\)/g) ?? []).length).toBe(16); // 🔻 TASK-411: + `POST /parents/:id/archive` // 🔻 TASK-406: + `POST /teachers/me/leave` // 🔻 TASK-390: + `DELETE /courses/:id/rental`; 🔻 TASK-392: + `POST /students/:id/archive`
    for (const f of ["src/routes/api.ts", "src/routes/users.ts", "src/routes/auth.ts", "src/routes/register.ts", "src/routes/checkin.ts"]) {
      expect({ f, subActor: code(src(f)).includes('c.get("user")?.sub') }).toEqual({ f, subActor: false });
    }
    expect(code(src("src/services/user.service.ts"))).toContain("export const actorOf = ");
  });
  test("the env login is RETIRED: nothing reads ADMIN_USERNAME / ADMIN_PASSWORD; `.env.example` names the bootstrap pair", () => {
    for (const f of ["src/routes/auth.ts", "src/middleware/auth.ts", "src/index.ts", "src/services/user.service.ts"]) {
      expect({ f, env: /ADMIN_USERNAME|ADMIN_PASSWORD/.test(code(src(f)).replace(/BOOTSTRAP_ADMIN_(USERNAME|PASSWORD)/g, "")) }).toEqual({ f, env: false });
    }
    const ENV = readFileSync(resolve(root, ".env.example"), "utf8");
    expect(ENV).toContain("BOOTSTRAP_ADMIN_USERNAME=");
    expect(ENV).toContain("BOOTSTRAP_ADMIN_PASSWORD=");
    expect(ENV).not.toMatch(/^ADMIN_USERNAME=/m);
  });
  test("the guard: verify → load the row by `sub` → 401 missing / 401 disabled (its own sentence) → AuthUser; `requireRole` is gone", () => {
    const MW = code(src("src/middleware/auth.ts"));
    expect(MW).toContain("const row = await findUserById(sub);");
    expect(MW).toContain('if (row.disabledAt) throw new ApiException(401, "UNAUTHORIZED", "บัญชีนี้ถูกปิดใช้งาน");');
    expect(MW).toContain("c.set(\"user\", toAuthUser(row, row.isSuperAdmin ? [] : await effectiveGrantKeys(row.id, row.roleId)));"); // 🔻 TASK-381: + the grants
    expect(MW).not.toContain("requireRole");
    expect(MW).toContain("export async function requireSuperAdmin(");
    expect(code(src("src/routes/users.ts"))).toContain('.use("*", requireSuperAdmin)');
    expect(code(src("src/index.ts"))).toContain('app.route("/api/users", userRoutes);');
    expect(code(src("src/index.ts")).indexOf('app.route("/api/users"')).toBeGreaterThan(code(src("src/index.ts")).indexOf('app.use("/api/*", authMiddleware);'));
  });
  test("the claim carries sub = id, username, role, isSuperAdmin; `assertMayDiscount` reads the KEY now (TASK-385 retired the `role` reader)", () => {
    const AUTH = code(src("src/routes/auth.ts"));
    expect(AUTH).toContain("signToken({ sub: user.id, username: user.username, role, isSuperAdmin: user.isSuperAdmin })");
    expect(AUTH).toContain('user.isSuperAdmin ? ("super_admin" as const) : ("admin" as const)');
    // 🔻 TASK-379: `role !== "admin"` refused the super admin — the capability was read; 🔻 TASK-385: the KEY is read.
    expect(code(src("src/lib/discount-plan.ts"))).toContain('if (!hasAction(user, "action:sales.discount")) throw new ApiException(403, "FORBIDDEN", "ไม่มีสิทธิ์ให้ส่วนลด");');
    expect(code(src("src/lib/discount-plan.ts"))).not.toContain("user.role");
  });
  test("USERNAME_TAKEN: the UNIQUE's 23505 is caught in the service (onError would say SLOT_TAKEN)", () => {
    const C = region(code(src("src/services/user.service.ts")), "export async function createUser(", "export const wouldRemoveLastSuperAdmin");
    expect(C).toContain('if (pgErrorCode(e) !== "23505") throw e;');
    expect(C).toContain('throw conflict("USERNAME_TAKEN"');
    expect(C).toContain("passwordHash: await hashPassword(input.password)");
  });
  test("🔑 the peer count behind LAST_SUPER_ADMIN counts ENABLED super admins only, excluding the target — a disabled peer is no peer", () => {
    // Mutation E of this task passed until this pin: the rule was pure and pinned, but the QUERY feeding it was not.
    const Q = region(code(src("src/services/user.service.ts")), "async function otherEnabledSuperAdmins(", "async function mustFind(");
    expect(Q).toContain(".where(and(eq(users.isSuperAdmin, true), isNull(users.disabledAt), ne(users.id, id)));");
    const SVC = code(src("src/services/user.service.ts"));
    expect(SVC).toContain("if (!input.isSuperAdmin && wouldRemoveLastSuperAdmin(row, await otherEnabledSuperAdmins(id))) throw LAST_SUPER_ADMIN();");
    expect(SVC).toContain("if (disabled && wouldRemoveLastSuperAdmin(row, await otherEnabledSuperAdmins(id))) throw LAST_SUPER_ADMIN();");
  });
  test("🔴 48 = 48 (0037 … 0047 added since): `0036_users` is the 37th file, idx 36; two tables, the UNIQUE on user_permissions LAST; the witness; the lock sentence", () => {
    const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBe(48);
    expect(files[36]).toBe("0036_users.sql");
    const j = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    expect(j.entries.length).toBe(48);
    expect(j.entries[36]).toMatchObject({ idx: 36, tag: "0036_users" });
    const SQL = readFileSync(resolve(root, "drizzle/0036_users.sql"), "utf8").replace(/\r\n/g, "\n");
    const body = SQL.replace(/^--.*$/gm, "");
    expect(body).toContain('CREATE TABLE IF NOT EXISTS "users"');
    expect(body).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "users_username_uq"');
    expect(body).toContain('CREATE TABLE IF NOT EXISTS "user_permissions"');
    expect(body).toContain('"user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE');
    expect(body.trim().endsWith('CREATE UNIQUE INDEX IF NOT EXISTS "user_permissions_user_key_uq" ON "user_permissions" ("user_id", "key");')).toBe(true);
    expect((SQL.match(/--> statement-breakpoint/g) ?? []).length).toBe(3);
    expect(SQL).toContain("No lock is taken on\n--     any EXISTING table");
    expect(SQL).toContain("ONE run, ONE transaction, four statements");
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0036_users")!; // 🔻 TASK-387/390: no longer last — found by tag
    expect(w).toMatchObject({ tag: "0036_users", probe: { kind: "index", index: "user_permissions_user_key_uq" }, rerunnable: true });
  });
});
