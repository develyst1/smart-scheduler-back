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

const ttlSeconds = () => Number(process.env.JWT_TTL_SECONDS ?? 12 * 3600);

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
