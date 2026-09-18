import { Hono } from "hono";
import { zValidator } from "../lib/validate";
import * as v from "../validation";
import { requireSuperAdmin } from "../middleware/auth";
import * as rolesSvc from "../services/role.service";
import { actorOf } from "../services/user.service";

// TASK-387 (REQ-092 Stage 4) — role management, SUPER ADMIN ONLY. Mounted under the `/api/*` guard, excluded from
// the access table like `/users`, then this group's own `requireSuperAdmin`. Deleting a role in use is refused
// with the holder count — the super admin reassigns first.
export const roleRoutes = new Hono()
  .use("*", requireSuperAdmin)
  .get("/", async (c) => c.json({ roles: await rolesSvc.listRoles() }))
  .post("/", zValidator("json", v.createRole), async (c) => c.json({ role: await rolesSvc.createRole(c.req.valid("json"), actorOf(c)) }, 201))
  .patch("/:id", zValidator("json", v.updateRole), async (c) => c.json({ role: await rolesSvc.updateRole(c.req.param("id"), c.req.valid("json"), actorOf(c)) }))
  .delete("/:id", async (c) => c.json(await rolesSvc.deleteRole(c.req.param("id"))));
