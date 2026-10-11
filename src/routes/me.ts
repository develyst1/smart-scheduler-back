import { Hono } from "hono";
import { zValidator } from "../lib/validate";
import * as v from "../validation";
import { changeOwnPassword } from "../services/user.service";
import { actionsOf, menusOf } from "../lib/permissions";
import { roleNameOf } from "../services/role.service";
import { isLineLinked, issueLineLinkCode } from "../services/admin-line-link.service";

// TASK-383 (REQ-092 Stage 2 patch) — the SIGNED-IN user's own routes, at `/api/me`: under the normal `/api/*` JWT
// guard, EXCLUDED from the menu table like `/users/*` (a zero-menu user must reach both — `menus: []` IS the
// shell's fact, and they must be able to change their password). 🚫 Not under `/auth`: on the FE host NextAuth's
// catch-all owns `/api/auth/*` and only `/auth/login` is proxied — TASK-381 put these there and they were
// unreachable on `sid` (Tanya). Moved, not aliased: one path.
export const meRoutes = new Hono()
  .get("/", async (c) => {
    const u = c.get("user");
    // TASK-387: `menus`/`actions` are EFFECTIVE (the guard's own set); `roleName` for the header — one small read, none without a role.
    return c.json({ user: { id: u.id, username: u.username, displayName: u.displayName, isSuperAdmin: u.isSuperAdmin, menus: menusOf(u), actions: actionsOf(u), roleName: await roleNameOf(u.roleId), teacherId: u.teacherId } }); // TASK-406: the FE learns it is scoped (never decides by it)
  })
  // 🔴 TASK-725 — a one-time code to link MY LINE account (admin notices): 8 symbols, 10 minutes, single use, stored hashed. Refused for a coach account and for
  // a disabled user. The plain code is in THIS response only. No body: the user is the token's, never a parameter.
  .post("/line-link-code", async (c) => c.json(await issueLineLinkCode(c.get("user").id)))
  // TASK-725 — has THIS user linked a LINE account? A boolean only. 🔑 Its OWN route, not a field of `GET /me`: `/me` is read on every page load by the shell, and
  // this answer is wanted only where the link dialog opens — so the hot path stays exactly as it was (no extra read), and the dialog asks when it needs it.
  .get("/line-link", async (c) => c.json({ lineLinked: await isLineLinked(c.get("user").id) }))
  .post("/password", zValidator("json", v.changeOwnPassword), async (c) => {
    const { currentPassword, newPassword } = c.req.valid("json");
    return c.json(await changeOwnPassword(c.get("user").id, currentPassword, newPassword));
  });
