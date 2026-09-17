// Auth guard (B.7). TASK-377 (REQ-092 RBAC Stage 1): the token identifies the user; the ROW decides.
//
// 🔴 The guard loads the user row on EVERY request (one primary-key read) and refuses a missing or DISABLED user
// with a 401 — revocation within the request, not the token's TTL. `c.get("user")` is an `AuthUser` built from
// the row (never from the claim alone); `grants` is empty until Stage 2 fills it. No route reads `.sub` any
// more — every actor is `actorOf(c)` (the username).
//
// 📌 The disabled sentence is the GUARD's own: the caller holds a valid token for that account, so there is
// nothing to enumerate — unlike login, where unknown / wrong / disabled share one sentence.

import type { Context, Next } from "hono";
import { verifyToken } from "../lib/jwt";
import { ApiException } from "../lib/http";
import { findUserById, userGrantKeys } from "../services/user.service";
import { hasMenu, type MenuKey } from "../lib/permissions";
import { ROUTE_MENUS, routeKey } from "../lib/route-menus";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  isSuperAdmin: boolean;
  role: "super_admin" | "admin";
  /** Stage 2 onward — the user's permission keys. Empty in Stage 1; a super admin ignores it. */
  grants: Set<string>;
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

export const authDisabled = () => process.env.SKIP_AUTH === "true";

/** A well-formed `sub` (the users table's uuid PK). A legacy `"admin"` fails this and never reaches the database. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `SKIP_AUTH=true` (dev / tests): a full super-admin user object, so every guard and every actor site behaves. */
export const DEV_USER: AuthUser = { id: "dev", username: "dev", displayName: "dev", isSuperAdmin: true, role: "super_admin", grants: new Set() };

export const toAuthUser = (row: { id: string; username: string; displayName: string; isSuperAdmin: boolean }, grants: Iterable<string> = []): AuthUser => ({
  id: row.id,
  username: row.username,
  displayName: row.displayName,
  isSuperAdmin: row.isSuperAdmin,
  role: row.isSuperAdmin ? "super_admin" : "admin",
  grants: new Set(grants),
});

export async function authMiddleware(c: Context, next: Next) {
  if (authDisabled()) {
    c.set("user", DEV_USER);
    return next();
  }
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new ApiException(401, "UNAUTHORIZED", "ต้องเข้าสู่ระบบก่อน");
  let sub: string;
  try {
    sub = (await verifyToken(token)).sub;
  } catch {
    throw new ApiException(401, "UNAUTHORIZED", "โทเคนไม่ถูกต้องหรือหมดอายุ");
  }
  // 🔴 TASK-380 §2 — the claim's SHAPE before the read: a pre-Stage-1 token carries `sub = "admin"`, and a
  // non-UUID against the `uuid` column makes Postgres throw 22P02 before `!row` could answer. Every admin
  // logged in before the cutover hit a 500 on their first call instead of "sign in again". A malformed `sub`
  // is the token sentence with NO query; a real database error on a well-formed id stays a 500 — no catch-all.
  if (!UUID_RE.test(sub)) throw new ApiException(401, "UNAUTHORIZED", "โทเคนไม่ถูกต้องหรือหมดอายุ");
  const row = await findUserById(sub);
  if (!row) throw new ApiException(401, "UNAUTHORIZED", "โทเคนไม่ถูกต้องหรือหมดอายุ");
  if (row.disabledAt) throw new ApiException(401, "UNAUTHORIZED", "บัญชีนี้ถูกปิดใช้งาน");
  // TASK-381 (Stage 2): the grants ride with the row — ONE index read on `user_permissions`, and only for a
  // NON-super-admin (a super admin ignores the table; Stage 1's single read stays theirs).
  c.set("user", toAuthUser(row, row.isSuperAdmin ? [] : await userGrantKeys(row.id)));
  return next();
}

/**
 * TASK-381 (REQ-092 Stage 2) — the MENU guard's primitive: passes for a super admin or ANY of the listed menus;
 * else `403 FORBIDDEN "ไม่มีสิทธิ์เข้าถึงเมนูนี้"`. Several menus because a shared read serves several pages.
 */
export const MENU_FORBIDDEN = () => new ApiException(403, "FORBIDDEN", "ไม่มีสิทธิ์เข้าถึงเมนูนี้");
export function requireMenu(...menus: MenuKey[]) {
  return async (c: Context, next: Next) => {
    if (!hasMenu(c.get("user"), ...menus)) throw MENU_FORBIDDEN();
    return next();
  };
}

/**
 * 🔴 TASK-381 — ONE guard for every `/api/*` route, driven by `ROUTE_MENUS` (the table traced from the FE's real
 * calls). It reads the HANDLER route Hono matched (`c.req.matchedRoutes`, skipping middleware patterns), looks
 * it up, and applies `requireMenu`. `/auth/*` and `/users/*` are not menu-gated (public login + the JWT for
 * `/auth/me*`; `requireSuperAdmin` for users). **A route with NO entry is refused and logged — an auth guard
 * fails CLOSED** — and the enumeration test makes an unmapped route unshippable.
 */
export async function menuGuard(c: Context, next: Next) {
  const handler = [...c.req.matchedRoutes].reverse().find((r) => !r.path.endsWith("*") && r.method !== "ALL");
  if (!handler) return next(); // no route matched at all — that is `notFound`'s 404 (TASK-297), not a menu refusal
  const path = handler.path;
  if (/^\/api\/(auth|users)(\/|$)/.test(path)) return next();
  const menus = ROUTE_MENUS[routeKey(c.req.method, path)];
  if (!menus) {
    console.error(`[rbac] route not in ROUTE_MENUS — refused closed: ${c.req.method} ${path} (add it to lib/route-menus.ts)`);
    throw MENU_FORBIDDEN();
  }
  if (!hasMenu(c.get("user"), ...menus)) throw MENU_FORBIDDEN();
  return next();
}

/** Super admin only — the users group. (`requireRole` is retired.) */
export async function requireSuperAdmin(c: Context, next: Next) {
  const user = c.get("user");
  if (!user?.isSuperAdmin) throw new ApiException(403, "FORBIDDEN", "เฉพาะผู้ดูแลระบบสูงสุดเท่านั้น");
  return next();
}
