// TASK-450 (REQ-105 §7d) — 🔴 `camp_weeks` / `camp_days` were queried with the literal string `"undefined"`, which
// Postgres answers with `22P02 invalid input syntax for type uuid` — a 500 for what is a malformed request, and a
// log line that accuses the database of a caller's bug.
//
// 🔑 ONE place, not sixty-five: `accessGuard` already proves that a middleware can see the route PATTERN it matched
// (`c.req.matchedRoutes`), so the pattern plus the actual path is all a guard needs — every `:id` (and every
// `:somethingId`) in this API is a uuid, while — 🔻 TASK-463 — the free-form ones are declared PER ROUTE in `FREE_FORM_PARAMS` below.
import type { Context, Next } from "hono";
import { badRequest } from "../lib/http";

/**
 * 🔴 TASK-463 (DEF-2) — this guard used to decide by param NAME: `:id` / `:somethingId` checked, `:key` and `:date`
 * skipped, because `:key` was a settings key. The series routes then named a UUID `:key`, the guard skipped exactly
 * the params that were uuids, and `/other-series/undefined` reached Postgres as `22P02` ⇒ 500. An exclusion by name
 * is a bet that no future route uses that name differently — lost inside two weeks. ⇒ **Every param is a uuid unless
 * ITS ROUTE says otherwise.** A new route with a non-uuid param fails closed (400) until declared — the safe direction.
 *
 * The ONLY params that are not uuids — by full route pattern (as `matchedRoutes` reports it), each with its reason.
 * 🔑 Declared per ROUTE, so `/settings/:key` can be free-form while `/other-series/:key` is a uuid.
 */
export const FREE_FORM_PARAMS: Readonly<Record<string, readonly string[]>> = {
  "/api/settings/:key": ["key"], // a settings key, e.g. `checkin_early_minutes` — the registry validates it
  "/api/camp/weeks/:id/days/:date": ["date"], // a YYYY-MM-DD business date — the camp service validates it
  "/api/calendar/:file": ["file"], // `<token>.ics` — mounted before this guard, declared so this map is the COMPLETE list
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: string): boolean => UUID.test(v);

/** Pure: the param NAMES this request fills with something that is not a uuid. `[]` = nothing to refuse. */
export function badUuidParams(pattern: string, path: string): string[] {
  const free = FREE_FORM_PARAMS[pattern] ?? [];
  const p = pattern.split("/");
  const actual = path.split("/");
  const bad: string[] = [];
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    if (!seg?.startsWith(":")) continue;
    const name = seg.slice(1).replace(/[?{].*$/, "");
    if (free.includes(name)) continue;
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
