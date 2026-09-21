// TASK-426 (REQ-102, narrowed) — the Freelance salary ceiling on the frontoffice is behind ONE key nobody holds by
// default: `action:teachers.budget-view`. The four figures the ONE builder (`attachFreelanceBudgets`) derives from the
// ceiling row — the hourly pay rate, the monthly budget, the remaining and the reorder threshold — read `null` for a
// viewer without the key; the BOOLEANS (`overLimit`, `setupIncomplete`, `limitOverride`) stay, because they are the
// booking rule ("not bookable"), not money. A LINKED account (REQ-097, a teacher) is masked regardless of its grants — the
// `GET /teachers` leak. `viewer = null` ⇒ masked: fail closed. 🚫 Nothing else is masked by this file — price cards,
// `rate{}`, `other.teacherRates`, sales, reports are the owner's "out of scope".
import { hasAction } from "./permissions";
import { isScoped } from "./own-scope";

export const BUDGET_VIEW_KEY = "action:teachers.budget-view" as const;

/** Who is reading — what the route knows from the token. `null` = nobody (a job, a test without a user) ⇒ masked. */
export type Viewer = { isSuperAdmin: boolean; grants: ReadonlySet<string>; teacherId?: string | null } | null;

/** The four ceiling-derived figures; the ONLY fields this mask touches. */
export const BUDGET_FIGURE_FIELDS = ["hourlyRate", "budgetMinor", "remainingMinor", "reorderMinor"] as const;

/** May this viewer see the figures? The key, and never a linked account. Pure. */
export const canSeeBudget = (viewer: Viewer): boolean =>
  !!viewer && !isScoped({ teacherId: viewer.teacherId ?? null }) && hasAction(viewer, BUDGET_VIEW_KEY);

/** The mask — in place, the shape unchanged: the four figures ⇒ `null` without the key; the booleans untouched. */
export function maskBudget<T extends { hourlyRate?: number | null; budgetMinor?: number | null; remainingMinor?: number | null; reorderMinor?: number | null }>(viewer: Viewer, dto: T): T {
  if (canSeeBudget(viewer)) return dto;
  for (const f of BUDGET_FIGURE_FIELDS) if (f in dto) (dto as any)[f] = null;
  return dto;
}

/** The viewer from a request context — beside `actorOf`; the ONE way a route hands the token to a reader. */
export const viewerOf = (c: { get: (k: "user") => any }): Viewer => {
  const u = c.get("user");
  return u ? { isSuperAdmin: !!u.isSuperAdmin, grants: u.grants ?? new Set(), teacherId: u.teacherId ?? null } : null;
};
