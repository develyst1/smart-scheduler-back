// TASK-431 (REQ-102 §6/§7) — the §13.3 coach rate is behind ONE key, VIEW ⇔ EDIT coupled: `action:bookings.coach-rate`.
// Without it the figure is HIDDEN (the booking DTO's `rate` and the course DTO's / the plan's `classRateMinor` read null —
// the shape kept) and the EDIT is ABSENT (a body carrying the rate is refused 403 before any service runs). Fail-closed:
// nobody holds the key by default, a linked (teacher) account never, `viewer = null` ⇒ hidden. INDEPENDENT of the freelance
// budget key (57): this file never reads it and `budget-visibility.ts` never reads this one.
//
// 🔑 THE SEAM (TASK-431 §1.3): the rate has exactly TWO producers in src, both pure mappers without a viewer (`rateFacts`
// → `rate`; `duoCourseFacts` → `classRateMinor`), reached from ~21 service call sites. So the read mask is ONE response
// walk at `/api/*` after the guard (`coachRateMask` in index.ts) that nulls exactly those two keys — fail-closed BY
// CONSTRUCTION for every reader added tomorrow. `hourlyRate` / `budgetMinor` are key 57's and untouched.
// 🔻 TASK-434 (REQ-102 §8, the owner): ONE key on EVERY rate surface — the Stage-1 ECA/Group per-teacher rates
// (`other.teacherRates`, `group.teacherRates`, the series DTOs' `teacherRates`) join the mask and the write check; the rate
// is OPTIONAL at the DUO create (`duo` alone no longer trips the check — only a rate field does).
import { ApiException } from "./http";
import { hasAction } from "./permissions";
import { isScoped } from "./own-scope";
import type { Viewer } from "./budget-visibility";

export const COACH_RATE_KEY = "action:bookings.coach-rate" as const;

/** The exact response keys the mask nulls — the two mappers' names, nothing else (pinned by a src scan). */
export const COACH_RATE_KEYS = ["rate", "classRateMinor", "teacherRates"] as const;

/** May this viewer see (⇔ edit) the coach rate? The key, and never a linked account. Pure. */
export const canSeeCoachRate = (viewer: Viewer): boolean =>
  !!viewer && !isScoped({ teacherId: viewer.teacherId ?? null }) && hasAction(viewer, COACH_RATE_KEY);

/** The read mask — a NEW value with every `rate` / `classRateMinor` key set to null, at any depth; non-objects pass through. */
export function maskCoachRate<T>(body: T): T {
  if (Array.isArray(body)) return body.map(maskCoachRate) as T;
  if (body && typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = (COACH_RATE_KEYS as readonly string[]).includes(k) ? null : maskCoachRate(v);
    }
    return out as T;
  }
  return body;
}

/** The body fields that ARE a rate edit — present (any value, null included: clearing IS an edit) ⇒ the key is needed. */
export const COACH_RATE_BODY_FIELDS = ["classRateMinor", "teacherRates", "rateMinor"] as const;

/** Does this body edit a coach rate? Any rate field at the top level, or `duo.classRateMinor` (TASK-434: `duo` alone is not an edit). */
export const bodyEditsCoachRate = (body: unknown): boolean => {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (COACH_RATE_BODY_FIELDS.some((f) => f in b)) return true;
  const duo = b.duo;
  return !!duo && typeof duo === "object" && "classRateMinor" in (duo as object);
};

/** The write half of view ⇔ edit — the `assertMayDiscount` shape: called at the ROUTE, before the service. */
export function assertMayEditCoachRate(body: unknown, user: Viewer): void {
  if (!bodyEditsCoachRate(body)) return;
  if (!canSeeCoachRate(user)) throw new ApiException(403, "FORBIDDEN", "ไม่มีสิทธิ์แก้ค่าสอน");
}
