import { Hono } from "hono";
import { zValidator } from "../lib/validate";
import * as v from "../validation";
import { requireSuperAdmin } from "../middleware/auth";
import * as usersSvc from "../services/user.service";
import { actorOf } from "../services/user.service";

// TASK-377 (REQ-092 Stage 1) — user management, SUPER ADMIN ONLY. Mounted under the `/api/*` guard, then this
// group's own `requireSuperAdmin`. No delete: disable is the off switch (the row is an audit name).
export const userRoutes = new Hono()
  .use("*", requireSuperAdmin)
  .get("/", async (c) => c.json({ users: await usersSvc.listUsers() }))
  .post("/", zValidator("json", v.createUser), async (c) =>
    c.json({ user: await usersSvc.createUser(c.req.valid("json"), actorOf(c)) }, 201),
  )
  .patch("/:id", zValidator("json", v.updateUser), async (c) =>
    c.json({ user: await usersSvc.updateUser(c.req.param("id"), c.req.valid("json")) }),
  )
  .post("/:id/password", zValidator("json", v.resetPassword), async (c) =>
    c.json(await usersSvc.resetPassword(c.req.param("id"), c.req.valid("json").password)),
  )
  // TASK-381 — replace the user's menu grants; the server refuses within the request, the nav follows on `/auth/me`.
  .put("/:id/menus", zValidator("json", v.setUserMenus), async (c) =>
    c.json({ user: await usersSvc.setUserMenus(c.req.param("id"), c.req.valid("json").keys, actorOf(c)) }),
  )
  .post("/:id/disable", async (c) => c.json({ user: await usersSvc.setUserDisabled(c.req.param("id"), true) }))
  .post("/:id/enable", async (c) => c.json({ user: await usersSvc.setUserDisabled(c.req.param("id"), false) }));
