// Auth middleware (B.7). Protects /api: requires a valid Bearer JWT, attaches the
// claims to the context. `SKIP_AUTH=true` (dev) bypasses it with a default admin —
// secure by default, opt-out only for local work / until the FE sends tokens.

import type { Context, Next } from "hono";
import { verifyToken, type AuthClaims, type Role } from "../lib/jwt";
import { ApiException } from "../lib/http";

// Make c.get("user") / c.set("user", …) type-safe everywhere.
declare module "hono" {
  interface ContextVariableMap {
    user: AuthClaims;
  }
}

export const authDisabled = () => process.env.SKIP_AUTH === "true";

const DEV_USER: AuthClaims = { sub: "dev", role: "admin" };

export async function authMiddleware(c: Context, next: Next) {
  if (authDisabled()) {
    c.set("user", DEV_USER);
    return next();
  }
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new ApiException(401, "UNAUTHORIZED", "ต้องเข้าสู่ระบบก่อน");
  try {
    c.set("user", await verifyToken(token));
  } catch {
    throw new ApiException(401, "UNAUTHORIZED", "โทเคนไม่ถูกต้องหรือหมดอายุ");
  }
  return next();
}

/** Route guard for role-restricted actions (e.g. admin-only). */
export function requireRole(...roles: Role[]) {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    if (!user || !roles.includes(user.role))
      throw new ApiException(403, "FORBIDDEN", "ไม่มีสิทธิ์ดำเนินการนี้");
    return next();
  };
}
