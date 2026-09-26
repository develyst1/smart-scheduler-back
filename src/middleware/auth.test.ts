// Auth guard (B.7) — 🔻 TASK-377 (REQ-092 RBAC Stage 1): login is against the `users` TABLE and the guard loads
// the row per request. The user service is spied (the suite never connects); the claim shape, the row read, the
// disabled refusal and the two sentences are what this file pins now. The old env-login pins are GONE with the
// env login (retired, SPEC-079 §3.1).
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { authMiddleware, requireSuperAdmin } from "./auth";
import { authRoutes } from "../routes/auth";
import { ApiException } from "../lib/http";
import * as usersSvc from "../services/user.service";
import { ACTION_KEYS, MENU_KEYS } from "../lib/permissions";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import { userPermissions } from "../db/schema";

process.env.JWT_SECRET ??= "test-secret";

const ROW = { id: "11111111-1111-4111-8111-111111111111", username: "admin", displayName: "Admin", isSuperAdmin: true, disabledAt: null as Date | null, createdAt: new Date("2026-09-17T00:00:00Z"), passwordHash: "hash" };
const STAFF = { ...ROW, id: "22222222-2222-4222-8222-222222222222", username: "staff", isSuperAdmin: false };
let disabled = false;
/** 🔴 TASK-504 — whose individual grants the LOGIN asked for (see the `db.select` fake below). */
const grantReads: unknown[] = [];
const spies = [
  spyOn(usersSvc, "authenticate").mockImplementation((async (u: string, p: string) => (u === "admin" && p === "admin" ? { ...ROW } : u === "staff" && p === "staffpass" ? { ...STAFF } : null)) as any),
  spyOn(usersSvc, "effectiveGrantKeys").mockImplementation((async () => []) as any), // TASK-381: the grants read, no DB
  // 🔴 TASK-504 — the LOGIN's own answer (`userDTO` → `userGrantKeys`) reads the user's INDIVIDUAL grants with a `db.select` on
  // `user_permissions` — a read the guard's spied `effectiveGrantKeys` never covered, so this file needed a real database (the
  // app's error handler turned the refused connection into a bare 500). These users have none: the honest fake is an EMPTY
  // `user_permissions`, answering only the real WHERE (this user's id) — any other select throws.
  spyOn(db, "select").mockImplementation((() => ({
    from: (t: any) => {
      if (t !== userPermissions) throw new Error(`unexpected select from ${getTableName(t)} in the auth test`);
      return {
        where: async (cond: any) => {
          const q = new PgDialect().sqlToQuery(cond);
          if (q.sql !== '"user_permissions"."user_id" = $1') throw new Error(`unexpected user_permissions read: ${q.sql}`);
          grantReads.push(q.params[0]);
          return [];
        },
      };
    },
  })) as any),
  spyOn(usersSvc, "findUserById").mockImplementation((async (id: string) => (id === "11111111-1111-4111-8111-111111111111" ? { ...ROW, disabledAt: disabled ? new Date() : null } : id === "22222222-2222-4222-8222-222222222222" ? { ...STAFF } : null)) as any),
];
afterAll(() => spies.forEach((s) => s.mockRestore()));

function makeApp() {
  const app = new Hono();
  app.route("/api/auth", authRoutes);
  app.use("/api/*", authMiddleware);
  app.get("/api/ping", (c) => c.json({ user: { ...c.get("user"), grants: [...c.get("user").grants] } }));
  app.get("/api/super", requireSuperAdmin, (c) => c.json({ ok: true }));
  app.onError((err, c) =>
    err instanceof ApiException
      ? c.json({ error: err.code, message: err.message }, err.status as any)
      : c.json({ error: "INTERNAL" }, 500),
  );
  return app;
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const origSkip = process.env.SKIP_AUTH;
afterAll(() => {
  if (origSkip === undefined) delete process.env.SKIP_AUTH;
  else process.env.SKIP_AUTH = origSkip;
});

describe("auth middleware (B.7 → TASK-377)", () => {
  test("SKIP_AUTH=true → bypass with the dev SUPER ADMIN user object (no `sub`, no `role: admin`)", async () => {
    process.env.SKIP_AUTH = "true";
    const res = await makeApp().request("/api/ping");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user).toEqual({ id: "dev", username: "dev", displayName: "dev", isSuperAdmin: true, role: "super_admin", roleId: null, grants: [], teacherId: null }); // 🔻 TASK-406: + teacherId // 🔻 TASK-387: + roleId
  });

  test("enforced + no token → 401", async () => {
    process.env.SKIP_AUTH = "false";
    const res = await makeApp().request("/api/ping");
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toBe("UNAUTHORIZED");
  });

  test("invalid token → 401", async () => {
    process.env.SKIP_AUTH = "false";
    const res = await makeApp().request("/api/ping", { headers: { authorization: "Bearer not.a.real.jwt" } });
    expect(res.status).toBe(401);
  });

  test("login is public even when the guard is enforced → token → the guard LOADS THE ROW and attaches the user", async () => {
    process.env.SKIP_AUTH = "false";
    const app = makeApp();
    grantReads.length = 0;
    const login = await app.request("/api/auth/login", json({ username: "admin", password: "admin" }));
    expect(login.status).toBe(200);
    expect(grantReads).toEqual([ROW.id]); // TASK-504 — the login's answer reads THIS user's own grants, once (undeclared until now)
    const { token, user } = (await login.json()) as any;
    expect(user).toEqual({ id: "11111111-1111-4111-8111-111111111111", username: "admin", displayName: "Admin", isSuperAdmin: true, disabledAt: null, createdAt: "2026-09-17T00:00:00.000Z", role: "super_admin", menus: [...MENU_KEYS], actions: [...ACTION_KEYS], roleId: null, roleName: null, teacherId: null, teacherName: null, grants: { fromRole: [], own: [] } }); // 🔻 TASK-387: + role fields; 🔻 TASK-381: a super admin's menus = all 12; 🔻 TASK-385: + all actions
    expect("passwordHash" in user).toBe(false);
    const ping = await app.request("/api/ping", { headers: { authorization: `Bearer ${token}` } });
    expect(ping.status).toBe(200);
    expect(((await ping.json()) as any).user).toEqual({ id: "11111111-1111-4111-8111-111111111111", username: "admin", displayName: "Admin", isSuperAdmin: true, role: "super_admin", roleId: null, grants: [], teacherId: null }); // 🔻 TASK-387: + roleId; 🔻 TASK-406: + teacherId
  });

  test("login with the wrong password → 401, ONE sentence (no enumeration)", async () => {
    process.env.SKIP_AUTH = "false";
    const res = await makeApp().request("/api/auth/login", json({ username: "admin", password: "nope" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).message).toBe("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
  });

  test("🔴 a DISABLED user's still-valid token is refused at the guard, with the guard's own sentence", async () => {
    process.env.SKIP_AUTH = "false";
    const app = makeApp();
    const { token } = (await (await app.request("/api/auth/login", json({ username: "admin", password: "admin" }))).json()) as any;
    disabled = true;
    try {
      const res = await app.request("/api/ping", { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
      expect(((await res.json()) as any).message).toBe("บัญชีนี้ถูกปิดใช้งาน");
    } finally {
      disabled = false;
    }
  });

  test("a token whose row is GONE → 401 with the token sentence", async () => {
    process.env.SKIP_AUTH = "false";
    const { signToken } = await import("../lib/jwt");
    const token = await signToken({ sub: "u-gone", username: "ghost", role: "admin", isSuperAdmin: false });
    const res = await makeApp().request("/api/ping", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).message).toBe("โทเคนไม่ถูกต้องหรือหมดอายุ");
  });

  test("requireSuperAdmin: a plain admin is 403; a super admin passes; the dev user passes", async () => {
    process.env.SKIP_AUTH = "false";
    const app = makeApp();
    const staff = (await (await app.request("/api/auth/login", json({ username: "staff", password: "staffpass" }))).json()) as any;
    expect(staff.user.role).toBe("admin");
    expect((await app.request("/api/super", { headers: { authorization: `Bearer ${staff.token}` } })).status).toBe(403);
    const admin = (await (await app.request("/api/auth/login", json({ username: "admin", password: "admin" }))).json()) as any;
    expect((await app.request("/api/super", { headers: { authorization: `Bearer ${admin.token}` } })).status).toBe(200);
    process.env.SKIP_AUTH = "true";
    expect((await makeApp().request("/api/super")).status).toBe(200);
  });
});
