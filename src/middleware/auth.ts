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
import { findUserById } from "../services/user.service";

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

/** `SKIP_AUTH=true` (dev / tests): a full super-admin user object, so every guard and every actor site behaves. */
export const DEV_USER: AuthUser = { id: "dev", username: "dev", displayName: "dev", isSuperAdmin: true, role: "super_admin", grants: new Set() };

export const toAuthUser = (row: { id: string; username: string; displayName: string; isSuperAdmin: boolean }): AuthUser => ({
  id: row.id,
  username: row.username,
  displayName: row.displayName,
  isSuperAdmin: row.isSuperAdmin,
  role: row.isSuperAdmin ? "super_admin" : "admin",
  grants: new Set(),
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
  const row = await findUserById(sub);
  if (!row) throw new ApiException(401, "UNAUTHORIZED", "โทเคนไม่ถูกต้องหรือหมดอายุ");
  if (row.disabledAt) throw new ApiException(401, "UNAUTHORIZED", "บัญชีนี้ถูกปิดใช้งาน");
  c.set("user", toAuthUser(row));
  return next();
}

/** Super admin only — the users group. Stage 2's `requirePermission(key)` will sit beside it. (`requireRole` is retired.) */
export async function requireSuperAdmin(c: Context, next: Next) {
  const user = c.get("user");
  if (!user?.isSuperAdmin) throw new ApiException(403, "FORBIDDEN", "เฉพาะผู้ดูแลระบบสูงสุดเท่านั้น");
  return next();
}
