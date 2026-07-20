// Thin client to the backoffice/ops API (port 3002) for teacher rate + income
// ceiling (UC-016). Best-effort: if OPS_API_URL is unset or the call fails, we
// return no rates and the calendar/teachers still work (ceiling just stays unset).
//
// Rates change rarely, so results are cached in-memory for a short TTL to avoid
// hitting backoffice on every calendar poll.

export interface TeacherQuota {
  hourlyRate: number | null; // THB/hour = the EXPENSE item's unit price
  rateMinor: number; // rate in satang (= the EXPENSE item's salePriceMinor) — the per-job drawdown
  remainingMinor: number; // remaining monthly budget in satang (stock on hand, SPEC-001)
  budgetMinor: number | null; // configured monthly budget (metadata.monthlyBudgetMinor), satang
  reorderMinor: number | null; // near-cap warning threshold (reorder_level), satang
}

// Read at call time (not module load) so config/tests can vary it without re-importing.
const opsApiUrl = () => process.env.OPS_API_URL?.replace(/\/$/, "");
const TTL_MS = 5 * 60_000;
const SCHEDULING_SOURCE = "smart-scheduler";

function opsHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (process.env.SERVICE_TOKEN) h["X-Service-Token"] = process.env.SERVICE_TOKEN;
  return h;
}

interface MovementOpts {
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
  amountMinor?: number;
  allowNegative?: boolean;
}

/** POST a movement to the item linked to (smart-scheduler, externalRef). Best-effort:
 *  never throws into the booking flow; no-op when OPS_API_URL is unset or the item is
 *  missing (404). A `409` (insufficient stock/budget) is surfaced as `blocked` so a
 *  caller that must enforce the cap can react; other failures are `skipped`. */
async function opsMovementByRef(
  externalRef: string,
  direction: "IN" | "OUT",
  quantity: number,
  opts: MovementOpts = {},
): Promise<{ ok: boolean; blocked?: boolean; skipped?: string }> {
  const OPS_API_URL = opsApiUrl();
  if (!OPS_API_URL) return { ok: false, skipped: "OPS_API_URL unset" };
  try {
    const res = await fetch(`${OPS_API_URL}/api/v1/catalog/items/by-ref/movements`, {
      method: "POST",
      headers: opsHeaders(true),
      body: JSON.stringify({ externalSource: SCHEDULING_SOURCE, externalRef, direction, quantity, ...opts }),
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 409) return { ok: false, blocked: true };
    return { ok: false, skipped: `ops ${res.status}` };
  } catch {
    return { ok: false, skipped: "ops unreachable" };
  }
}

/** Freelance booking committed → draw down the teacher's monthly budget-stock (EXPENSE item)
 *  by `amountMinor` satang (= rate × 1h). One movement = P&L expense + real-time cap. A `409`
 *  (budget exhausted, no override) comes back as `{ blocked:true }` so the caller aborts the
 *  booking. Pass `allowNegative` to honour an admin over-budget override (SPEC-001 / TASK-002). */
export function drawFreelanceBudget(
  teacherId: string,
  amountMinor: number,
  opts: { refId?: string; idempotencyKey?: string; allowNegative?: boolean } = {},
) {
  return opsMovementByRef(teacherId, "OUT", amountMinor, {
    refType: "BOOKING",
    amountMinor,
    refId: opts.refId,
    idempotencyKey: opts.idempotencyKey,
    allowNegative: opts.allowNegative ?? false,
  });
}

/** Cancel / customer-leave of a freelance booking → reverse the drawdown: return the budget,
 *  release the cap, un-book the P&L expense. `amountMinor` = the same satang drawn at booking. */
export function releaseFreelanceBudget(
  teacherId: string,
  amountMinor: number,
  opts: { refId?: string; idempotencyKey?: string } = {},
) {
  return opsMovementByRef(teacherId, "IN", amountMinor, {
    refType: "BOOKING_REVERSAL",
    amountMinor,
    refId: opts.refId,
    idempotencyKey: opts.idempotencyKey,
  });
}

/** Map a booking type to its INCOME item external ref for day-end revenue (TASK-007).
 *  Only one-off trial/single recognise revenue at attendance; course/voucher already booked
 *  revenue at sale, so they map to null (not re-posted at day-end). */
export function revenueItemRef(bookingType: string): string | null {
  if (bookingType === "FIRST_TRIAL") return "first-trial";
  if (bookingType === "SINGLE_SESSION") return "single-session";
  return null;
}

/** A course / voucher / trial was sold → record revenue on its INCOME item.
 *  `externalRef` is the product code (e.g. "course-6", "voucher-10"). */
export function recordSale(
  externalRef: string,
  quantity: number,
  opts: { refId?: string; idempotencyKey?: string; amountMinor?: number } = {},
) {
  return opsMovementByRef(externalRef, "OUT", quantity, { refType: "SALE", ...opts });
}

let cache: { at: number; map: Map<string, TeacherQuota> } | null = null;

/** teacher id → { hourlyRate, quotaRemaining } from each teacher's EXPENSE item in
 *  backoffice. Empty map when backoffice is off/unreachable. */
export async function fetchTeacherQuotas(): Promise<Map<string, TeacherQuota>> {
  const OPS_API_URL = opsApiUrl();
  if (!OPS_API_URL) return new Map();
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;

  const map = new Map<string, TeacherQuota>();
  try {
    const res = await fetch(
      `${OPS_API_URL}/api/v1/catalog/items?externalSource=${SCHEDULING_SOURCE}&itemType=EXPENSE`,
      { headers: opsHeaders(), signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return cache?.map ?? map;

    const body = (await res.json()) as {
      items?: Array<{
        externalRef: string | null;
        salePriceMinor: number;
        quantityOnHand: number;
        reorderLevel: number | null;
        metadata: Record<string, unknown> | null;
      }>;
    };
    for (const it of body.items ?? []) {
      if (it.externalRef) {
        const budget = it.metadata?.monthlyBudgetMinor;
        map.set(it.externalRef, {
          hourlyRate: it.salePriceMinor / 100,
          rateMinor: it.salePriceMinor,
          remainingMinor: it.quantityOnHand,
          budgetMinor: typeof budget === "number" ? budget : null,
          reorderMinor: it.reorderLevel ?? null,
        });
      }
    }
    cache = { at: Date.now(), map };
    return map;
  } catch {
    return cache?.map ?? map;
  }
}

/** The teacher's per-job drawdown in satang (their EXPENSE item's rate). null when
 *  backoffice is off / the teacher has no budget item — caller then skips the drawdown. */
export async function fetchFreelanceRateMinor(teacherId: string): Promise<number | null> {
  const quotas = await fetchTeacherQuotas();
  return quotas.get(teacherId)?.rateMinor ?? null;
}

interface QuotaTeacher {
  id: string;
  hourlyRate: number | null;
  remainingMinor?: number | null;
  budgetMinor?: number | null;
  reorderMinor?: number | null;
  overLimit?: boolean;
}

/** Merge each teacher's rate + budget (satang) onto their DTO (no-op when backoffice is
 *  off). overLimit = budget exhausted → the calendar hides them so admins spread the work. */
export async function attachTeacherQuotas<T extends QuotaTeacher>(teachers: T[]): Promise<T[]> {
  const quotas = await fetchTeacherQuotas();
  if (!quotas.size) return teachers;
  for (const t of teachers) {
    const q = quotas.get(t.id);
    if (q) {
      t.hourlyRate = q.hourlyRate;
      t.remainingMinor = q.remainingMinor;
      t.budgetMinor = q.budgetMinor;
      t.reorderMinor = q.reorderMinor;
      t.overLimit = q.remainingMinor <= 0;
    }
  }
  return teachers;
}
