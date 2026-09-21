// TASK-431 (REQ-102 §6/§7) — the ONE read seam for the §13.3 coach rate: after the handler answered, a viewer without
// `action:bookings.coach-rate` (or a linked account, or no viewer) gets the JSON body with every `rate` / `classRateMinor`
// key nulled (`lib/coach-rate-visibility.ts`). Registered on `/api/*` AFTER `accessGuard` (index.ts); `/api/me`,
// `/api/permissions` and the auth routes are outside it by path — they carry no DTO and stay byte-identical. A super admin
// (or a keyed staff) pays nothing: the body is not touched. Non-JSON answers pass through.
import type { Context, Next } from "hono";
import { canSeeCoachRate, maskCoachRate } from "../lib/coach-rate-visibility";
import { viewerOf } from "../lib/budget-visibility";

const OUTSIDE = /^\/api\/(auth|me|permissions)(\/|$)/;

export async function coachRateMask(c: Context, next: Next) {
  await next();
  if (OUTSIDE.test(c.req.path)) return;
  if (canSeeCoachRate(viewerOf(c))) return;
  const res = c.res;
  if (!res || !(res.headers.get("content-type") ?? "").includes("application/json")) return;
  const body = await res.clone().json().catch(() => undefined);
  if (body === undefined) return;
  c.res = new Response(JSON.stringify(maskCoachRate(body)), { status: res.status, headers: res.headers });
}
