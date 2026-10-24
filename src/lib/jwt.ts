// JWT (B.7). TASK-377 (REQ-092 Stage 1): the claim carries the USER ROW's id as `sub` (the standard claim) plus
// `username`, `role` and `isSuperAdmin`. The token is NOT the context: the guard loads the row per request and
// builds `AuthUser` from the row, so a disabled user is out within the request, not the TTL.

import { sign, verify } from "hono/jwt";

/** `"super_admin" | "admin"` are issued since TASK-377; `"staff"` stays in the type for the contract, never issued. */
export type Role = "super_admin" | "admin" | "staff";

export interface AuthClaims {
  sub: string;
  username: string;
  role: Role;
  isSuperAdmin: boolean;
  exp?: number;
}

// TASK-836 (REQ-128 L1): ONE fixed 7-day login (was 12 h, which threw a working user out mid-day). No silent renewal; the front session ends with this token. `JWT_TTL_SECONDS` still overrides.
export const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;
// A set value counts ONLY if it is a finite number > 0: an EMPTY line (`JWT_TTL_SECONDS=`, Number("") = 0), garbage (NaN) or ≤ 0 would expire every token the moment it is issued — those fall back to the default.
const ttlSeconds = () => {
  const v = Number(process.env.JWT_TTL_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_SECONDS;
};

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET not set");
  return s;
}

export async function signToken(claims: Omit<AuthClaims, "exp">): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds();
  return sign({ ...claims, exp }, secret(), "HS256");
}

export async function verifyToken(token: string): Promise<AuthClaims> {
  return (await verify(token, secret(), "HS256")) as unknown as AuthClaims;
}
