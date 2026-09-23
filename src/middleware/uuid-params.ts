// TASK-450 (REQ-105 §7d) — 🔴 `camp_weeks` / `camp_days` were queried with the literal string `"undefined"`, which
// Postgres answers with `22P02 invalid input syntax for type uuid` — a 500 for what is a malformed request, and a
// log line that accuses the database of a caller's bug.
//
// 🔑 ONE place, not sixty-five: `accessGuard` already proves that a middleware can see the route PATTERN it matched
// (`c.req.matchedRoutes`), so the pattern plus the actual path is all a guard needs — every `:id` (and every
// `:somethingId`) in this API is a uuid, while `:key` (a settings key) and `:date` deliberately are not.
import type { Context, Next } from "hono";
import { badRequest } from "../lib/http";

/** Params whose VALUE must be a uuid: `:id` and `:teacherId`-shaped names. `:key` and `:date` are excluded by name. */
export const UUID_PARAM_NAME = /^(id|[A-Za-z]+Id)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: string): boolean => UUID.test(v);

/** Pure: the param NAMES this request fills with something that is not a uuid. `[]` = nothing to refuse. */
export function badUuidParams(pattern: string, path: string): string[] {
  const p = pattern.split("/");
  const actual = path.split("/");
  const bad: string[] = [];
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    if (!seg?.startsWith(":")) continue;
    const name = seg.slice(1).replace(/[?{].*$/, "");
    if (!UUID_PARAM_NAME.test(name)) continue;
    const value = decodeURIComponent(actual[i] ?? "");
    if (!isUuid(value)) bad.push(name);
  }
  return bad;
}

/**
 * Refuse a malformed id BEFORE any query. Mounted after the access guard on purpose: a caller who may not see a
 * route must not learn its shape from a 400 (they keep getting the 403 they had).
 */
export async function uuidParamGuard(c: Context, next: Next) {
  const handler = [...c.req.matchedRoutes].reverse().find((r) => !r.path.endsWith("*") && r.method !== "ALL");
  if (handler) {
    const bad = badUuidParams(handler.path, c.req.path);
    if (bad.length) throw badRequest(`พารามิเตอร์ไม่ถูกต้อง: ${bad.join(", ")}`);
  }
  return next();
}
