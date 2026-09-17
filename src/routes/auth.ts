import { Hono } from "hono";
import { zValidator } from "../lib/validate";
import * as v from "../validation";
import { signToken } from "../lib/jwt";
import { ApiException } from "../lib/http";
import { authenticate, toUserDTO } from "../services/user.service";

// TASK-377 (REQ-092 Stage 1) — login against the `users` table. The old `ADMIN_USERNAME` / `ADMIN_PASSWORD`
// env login is RETIRED (nothing reads it); the first super admin is bootstrapped from `BOOTSTRAP_ADMIN_*` at the
// first login while the table is empty (see `bootstrapIfEmpty`). ONE sentence for unknown / wrong / disabled.
export const authRoutes = new Hono().post(
  "/login",
  zValidator("json", v.login),
  async (c) => {
    const { username, password } = c.req.valid("json");
    const user = await authenticate(username, password);
    if (!user) throw new ApiException(401, "UNAUTHORIZED", "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
    const role = user.isSuperAdmin ? ("super_admin" as const) : ("admin" as const);
    const token = await signToken({ sub: user.id, username: user.username, role, isSuperAdmin: user.isSuperAdmin });
    return c.json({ token, user: { ...toUserDTO(user), role } });
  },
);
