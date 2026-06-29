// Auth routes (B.7) — public (not behind the /api auth middleware).
// Phase 1 single-school login: credentials come from env (ADMIN_USERNAME/PASSWORD).
// A users table can replace this later without changing the token contract.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import { signToken } from "../lib/jwt";
import { ApiException } from "../lib/http";

export const authRoutes = new Hono().post(
  "/login",
  zValidator("json", v.login),
  async (c) => {
    const { username, password } = c.req.valid("json");
    const expectedUser = process.env.ADMIN_USERNAME ?? "admin";
    const expectedPass = process.env.ADMIN_PASSWORD ?? "admin";
    if (username !== expectedUser || password !== expectedPass)
      throw new ApiException(401, "UNAUTHORIZED", "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");

    const token = await signToken({ sub: username, role: "admin" });
    return c.json({ token, user: { username, role: "admin" as const } });
  },
);
