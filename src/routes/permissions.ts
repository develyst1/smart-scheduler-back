import { Hono } from "hono";
import { PERMISSION_REGISTRY } from "../lib/permissions";

// TASK-385 (REQ-092 Stage 3) — `GET /api/permissions`: the registry (menu keys + action keys with TH/EN labels) for
// any signed-in user. The FE renders the per-user checklists from THIS and keeps no second list of names. Under the
// JWT guard, excluded from the access table like `/me` (a zero-grant user may still read what exists).
export const permissionRoutes = new Hono().get("/", (c) => c.json(PERMISSION_REGISTRY));
