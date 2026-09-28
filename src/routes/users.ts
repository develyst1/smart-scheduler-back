import { Hono } from "hono";
import { zValidator } from "../lib/validate";
import * as v from "../validation";
import { requireSuperAdmin } from "../middleware/auth";
import * as usersSvc from "../services/user.service";
import { actorOf } from "../services/user.service";
import { listLineAdmins, removeLineAdmin } from "../services/line-admin-links.service";

// TASK-377 (REQ-092 Stage 1) — user management, SUPER ADMIN ONLY. Mounted under the `/api/*` guard, then this
// group's own `requireSuperAdmin`. No delete: disable is the off switch (the row is an audit name).
export const userRoutes = new Hono()
  .use("*", requireSuperAdmin)
  .get("/", async (c) => c.json({ users: await usersSvc.listUsers() }))
  // 🔴 TASK-538 — the LINE accounts linked as ADMIN, and removing one. In THIS group on purpose: super admin only by
  // `requireSuperAdmin`, like every power over who-can-do-what (users · roles · grants) — never a grantable action key.
  .get("/line-admins", async (c) => c.json(await listLineAdmins()))
  .delete("/line-admins/:ref", async (c) => c.json(await removeLineAdmin(c.req.param("ref"), actorOf(c))))
  .post("/", zValidator("json", v.createUser), async (c) =>
    c.json({ user: await usersSvc.createUser(c.req.valid("json"), actorOf(c)) }, 201),
  )
  .patch("/:id", zValidator("json", v.updateUser), async (c) =>
    c.json({ user: await usersSvc.updateUser(c.req.param("id"), c.req.valid("json")) }),
  )
  .post("/:id/password", zValidator("json", v.resetPassword), async (c) =>
    c.json(await usersSvc.resetPassword(c.req.param("id"), c.req.valid("json").password)),
  )
  // TASK-381 — replace the user's menu grants; the server refuses within the request, the nav follows on `/api/me` (TASK-383).
  .put("/:id/menus", zValidator("json", v.setUserMenus), async (c) =>
    c.json({ user: await usersSvc.setUserMenus(c.req.param("id"), c.req.valid("json").keys, actorOf(c)) }),
  )
  // TASK-385 — replace the user's action grants; independent of the menus.
  .put("/:id/actions", zValidator("json", v.setUserActions), async (c) =>
    c.json({ user: await usersSvc.setUserActions(c.req.param("id"), c.req.valid("json").keys, actorOf(c)) }),
  )
  // TASK-387 — assign / detach the LIVE role; own rows untouched (additive).
  .put("/:id/role", zValidator("json", v.setUserRole), async (c) =>
    c.json({ user: await usersSvc.setUserRole(c.req.param("id"), c.req.valid("json").roleId) }),
  )
  .post("/:id/disable", async (c) => c.json({ user: await usersSvc.setUserDisabled(c.req.param("id"), true) }))
  .post("/:id/enable", async (c) => c.json({ user: await usersSvc.setUserDisabled(c.req.param("id"), false) }));
