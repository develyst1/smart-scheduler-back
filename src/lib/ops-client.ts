// Thin client to the backoffice/ops API (port 3002) for teacher rate + income
// ceiling (UC-016). Best-effort: if OPS_API_URL is unset or the call fails, we
// return no rates and the calendar/teachers still work (ceiling just stays unset).
//
// Rates change rarely, so results are cached in-memory for a short TTL to avoid
// hitting backoffice on every calendar poll.

export interface TeacherQuota {
  hourlyRate: number | null; // THB/hour = the EXPENSE item's unit price
  quotaRemaining: number; // hours of monthly work quota left (stock on hand)
}

const OPS_API_URL = process.env.OPS_API_URL?.replace(/\/$/, "");
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
}

/** POST a movement to the item linked to (smart-scheduler, externalRef). Best-effort:
 *  never throws into the booking flow; no-op when OPS_API_URL is unset or the item is
 *  missing (404) / quota exhausted (409). */
async function opsMovementByRef(
  externalRef: string,
  direction: "IN" | "OUT",
  quantity: number,
  opts: MovementOpts = {},
): Promise<{ ok: boolean; skipped?: string }> {
  if (!OPS_API_URL) return { ok: false, skipped: "OPS_API_URL unset" };
  try {
    const res = await fetch(`${OPS_API_URL}/api/v1/catalog/items/by-ref/movements`, {
      method: "POST",
      headers: opsHeaders(true),
      body: JSON.stringify({ externalSource: SCHEDULING_SOURCE, externalRef, direction, quantity, ...opts }),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok ? { ok: true } : { ok: false, skipped: `ops ${res.status}` };
  } catch {
    return { ok: false, skipped: "ops unreachable" };
  }
}

/** Freelance teacher taught an hour → draw down their monthly quota (EXPENSE item).
 *  Records the labour cost in the company P&L and enforces the ceiling (409 at 0). */
export function consumeTeacherHours(
  teacherId: string,
  hours: number,
  opts: { refId?: string; idempotencyKey?: string } = {},
) {
  return opsMovementByRef(teacherId, "OUT", hours, { refType: "BOOKING", ...opts });
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
      items?: Array<{ externalRef: string | null; salePriceMinor: number; quantityOnHand: number }>;
    };
    for (const it of body.items ?? []) {
      if (it.externalRef) {
        map.set(it.externalRef, {
          hourlyRate: it.salePriceMinor / 100,
          quotaRemaining: it.quantityOnHand,
        });
      }
    }
    cache = { at: Date.now(), map };
    return map;
  } catch {
    return cache?.map ?? map;
  }
}

interface QuotaTeacher {
  id: string;
  hourlyRate: number | null;
  quotaRemaining?: number | null;
  overLimit?: boolean;
}

/** Merge each teacher's rate + remaining quota onto their DTO (no-op when backoffice is
 *  off). overLimit = quota exhausted → the calendar hides them so admins spread the work. */
export async function attachTeacherQuotas<T extends QuotaTeacher>(teachers: T[]): Promise<T[]> {
  const quotas = await fetchTeacherQuotas();
  if (!quotas.size) return teachers;
  for (const t of teachers) {
    const q = quotas.get(t.id);
    if (q) {
      t.hourlyRate = q.hourlyRate;
      t.quotaRemaining = q.quotaRemaining;
      t.overLimit = q.quotaRemaining <= 0;
    }
  }
  return teachers;
}
