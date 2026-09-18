import { Hono } from "hono";
import { zValidator } from "../lib/validate";
import * as v from "../validation";
import { changeOwnPassword } from "../services/user.service";
import { actionsOf, menusOf } from "../lib/permissions";
import { roleNameOf } from "../services/role.service";

// TASK-383 (REQ-092 Stage 2 patch) — the SIGNED-IN user's own routes, at `/api/me`: under the normal `/api/*` JWT
// guard, EXCLUDED from the menu table like `/users/*` (a zero-menu user must reach both — `menus: []` IS the
// shell's fact, and they must be able to change their password). 🚫 Not under `/auth`: on the FE host NextAuth's
// catch-all owns `/api/auth/*` and only `/auth/login` is proxied — TASK-381 put these there and they were
// unreachable on `sid` (Tanya). Moved, not aliased: one path.
export const meRoutes = new Hono()
  .get("/", async (c) => {
    const u = c.get("user");
    // TASK-387: `menus`/`actions` are EFFECTIVE (the guard's own set); `roleName` for the header — one small read, none without a role.
    return c.json({ user: { id: u.id, username: u.username, displayName: u.displayName, isSuperAdmin: u.isSuperAdmin, menus: menusOf(u), actions: actionsOf(u), roleName: await roleNameOf(u.roleId) } });
  })
  .post("/password", zValidator("json", v.changeOwnPassword), async (c) => {
    const { currentPassword, newPassword } = c.req.valid("json");
    return c.json(await changeOwnPassword(c.get("user").id, currentPassword, newPassword));
  });
