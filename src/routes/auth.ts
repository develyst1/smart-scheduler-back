import { Hono } from "hono";
import { zValidator } from "../lib/validate";
import * as v from "../validation";
import { signToken } from "../lib/jwt";
import { ApiException } from "../lib/http";
import { authenticate, changeOwnPassword, toUserDTO, userGrantKeys } from "../services/user.service";
import { authMiddleware } from "../middleware/auth";
import { menusOf } from "../lib/permissions";

// TASK-377 (REQ-092 Stage 1) — login against the `users` table. The old `ADMIN_USERNAME` / `ADMIN_PASSWORD`
// env login is RETIRED (nothing reads it); the first super admin is bootstrapped from `BOOTSTRAP_ADMIN_*` at the
// first login while the table is empty (see `bootstrapIfEmpty`). ONE sentence for unknown / wrong / disabled.
export const authRoutes = new Hono()
  .post("/login", zValidator("json", v.login), async (c) => {
    const { username, password } = c.req.valid("json");
    const user = await authenticate(username, password);
    if (!user) throw new ApiException(401, "UNAUTHORIZED", "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
    const role = user.isSuperAdmin ? ("super_admin" as const) : ("admin" as const);
    const token = await signToken({ sub: user.id, username: user.username, role, isSuperAdmin: user.isSuperAdmin });
    // The login body's `menus` come from the grants — one read, the same the guard will do on the next request.
    return c.json({ token, user: { ...toUserDTO(user, user.isSuperAdmin ? [] : await userGrantKeys(user.id)), role } });
  })
  // 🔴 TASK-381 — `/api/auth` is mounted BEFORE the JWT guard (login is public), so the two `me` routes carry the
  // guard EXPLICITLY. They are not menu-gated: a user with zero menus must still learn that (the shell's fact)
  // and change their own password.
  .use("/me", authMiddleware)
  .use("/me/*", authMiddleware)
  .get("/me", async (c) => {
    const u = c.get("user");
    return c.json({ user: { id: u.id, username: u.username, displayName: u.displayName, isSuperAdmin: u.isSuperAdmin, menus: menusOf(u) } });
  })
  .post("/me/password", zValidator("json", v.changeOwnPassword), async (c) => {
    const { currentPassword, newPassword } = c.req.valid("json");
    return c.json(await changeOwnPassword(c.get("user").id, currentPassword, newPassword));
  });
