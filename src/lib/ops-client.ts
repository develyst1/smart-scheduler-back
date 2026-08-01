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

// ⚠️ `recordSale` / `revenueItemRef` used to live here and went over the HTTP hop above. They moved
// to `lib/sale-post.ts` + `lib/sale-items.ts` in TASK-066: the route they called was retired by the
// REQ-006 rebuild, so every sale 404'd silently. Sales now write `bo.movement` directly, the way the
// freelance ceiling already does. **Nothing on the sale path calls this module any more.**

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

// ── Teacher-sync bridge (SPEC-004 / TASK-016). BLOCKING (admin actions, not the hot booking path):
//    these throw on failure so the caller can roll back — unlike the best-effort booking-time calls. ──
async function opsTeacherSync(action: string, body: Record<string, unknown>): Promise<unknown> {
  const OPS_API_URL = opsApiUrl();
  if (!OPS_API_URL) throw new Error("OPS_API_URL ไม่ได้ตั้งค่า — ซิงก์ครูกับ backoffice ไม่ได้");
  const res = await fetch(`${OPS_API_URL}/api/v1/internal/teacher-sync/${action}`, {
    method: "POST",
    headers: opsHeaders(true),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`ops teacher-sync ${action} ล้มเหลว (${res.status})`);
  return res.json();
}

export const onboardOpsTeacher = (id: string, displayName: string) =>
  opsTeacherSync("onboard", { externalRef: id, displayName });
export const updateOpsTeacher = (id: string, patch: { displayName?: string; active?: boolean }) =>
  opsTeacherSync("update", { externalRef: id, ...patch });
export const offboardOpsTeacher = (id: string, effectiveMonth: string) =>
  opsTeacherSync("offboard", { externalRef: id, effectiveMonth });
export const switchTypeOpsTeacher = (id: string, effectiveMonth: string) =>
  opsTeacherSync("switch-type", { externalRef: id, effectiveMonth });

/** teacherIds with an OPEN recurring salary row (FT/PT money is set). Best-effort → empty on failure. */
export async function fetchOpenSalaryTeacherIds(): Promise<Set<string>> {
  const OPS_API_URL = opsApiUrl();
  if (!OPS_API_URL) return new Set();
  try {
    const res = await fetch(
      `${OPS_API_URL}/api/v1/recurring-costs?externalSource=${SCHEDULING_SOURCE}`,
      { headers: opsHeaders(), signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return new Set();
    const body = (await res.json()) as {
      items?: Array<{ externalRef: string | null; effectiveTo: string | null }>;
    };
    const ids = new Set<string>();
    for (const r of body.items ?? []) {
      if (r.externalRef && r.effectiveTo === null) ids.add(r.externalRef);
    }
    return ids;
  } catch {
    return new Set();
  }
}

interface SetupTeacher {
  id: string;
  type: string;
  archived?: boolean;
  setupIncomplete?: boolean;
}

/** Pure money-setup rule (SPEC-004): a teacher is setup-incomplete until their money exists —
 *  FREELANCE ⇒ has a budget item; FT/PT ⇒ has an open salary row. Archived teachers are a separate
 *  state (offboarded), never "incomplete". */
export function isSetupIncomplete(
  teacher: { id: string; type: string; archived?: boolean },
  freelanceBudgetIds: Set<string>,
  openSalaryIds: Set<string>,
): boolean {
  if (teacher.archived) return false;
  const moneyReady =
    teacher.type === "FREELANCE" ? freelanceBudgetIds.has(teacher.id) : openSalaryIds.has(teacher.id);
  return !moneyReady;
}

/** Fetch both money-state sets from ops. `available` is false when backoffice returned nothing at all
 *  (off/unreachable) — callers then DON'T gate (can't tell "no money" from "ops down"; gating-all would
 *  hide every teacher on a transient blip). */
async function fetchMoneyState(): Promise<{
  budgetIds: Set<string>;
  salaryIds: Set<string>;
  available: boolean;
}> {
  const [quotas, salaryIds] = await Promise.all([fetchTeacherQuotas(), fetchOpenSalaryTeacherIds()]);
  const budgetIds = new Set(quotas.keys());
  return { budgetIds, salaryIds, available: budgetIds.size > 0 || salaryIds.size > 0 };
}

/** Set `setupIncomplete` on each teacher DTO from ops money-state (no-op when ops is unavailable). */
export async function attachSetupIncomplete<T extends SetupTeacher>(teachers: T[]): Promise<T[]> {
  const { budgetIds, salaryIds, available } = await fetchMoneyState();
  if (!available) return teachers;
  for (const t of teachers) t.setupIncomplete = isSetupIncomplete(t, budgetIds, salaryIds);
  return teachers;
}

/** Single-teacher money-setup check for the booking guard. False (don't block) when ops is unavailable. */
export async function isTeacherSetupIncomplete(teacherId: string, type: string): Promise<boolean> {
  const { budgetIds, salaryIds, available } = await fetchMoneyState();
  if (!available) return false;
  return isSetupIncomplete({ id: teacherId, type }, budgetIds, salaryIds);
}

// ── Reconcile (SPEC-004 #5.2 / TASK-018): throwing GETs so drift can't be masked by best-effort empties. ──
async function opsGetItems(pathAndQuery: string): Promise<Array<Record<string, unknown>>> {
  const OPS_API_URL = opsApiUrl();
  if (!OPS_API_URL) throw new Error("OPS_API_URL ไม่ได้ตั้งค่า");
  const res = await fetch(`${OPS_API_URL}/api/v1/${pathAndQuery}`, {
    headers: opsHeaders(),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`ops GET ${pathAndQuery} → ${res.status}`);
  const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
  return body.items ?? [];
}

const refsOf = (items: Array<Record<string, unknown>>) =>
  new Set(items.map((i) => i.externalRef).filter((r): r is string => typeof r === "string"));

/** ops parties (active) linked to scheduling → set of teacherIds. Throws if ops is unreachable. */
export async function fetchOpsPartyRefs(): Promise<Set<string>> {
  return refsOf(await opsGetItems(`parties?externalSource=${SCHEDULING_SOURCE}`));
}
/** teacherIds with an ACTIVE FREELANCE_BUDGET item (the list endpoint already filters active). */
export async function fetchOpsBudgetRefs(): Promise<Set<string>> {
  const items = await opsGetItems(`catalog/items?externalSource=${SCHEDULING_SOURCE}&itemType=EXPENSE`);
  return refsOf(
    items.filter(
      (i) => (i.metadata as Record<string, unknown> | null)?.kind === "FREELANCE_BUDGET",
    ),
  );
}
/** teacherIds with an OPEN salary row. */
export async function fetchOpsOpenSalaryRefs(): Promise<Set<string>> {
  const items = await opsGetItems(`recurring-costs?externalSource=${SCHEDULING_SOURCE}`);
  return refsOf(items.filter((r) => r.effectiveTo === null));
}

export interface ReconcileReport {
  missingParty: string[]; // teacherId — not archived, no ops party (onboard didn't land)
  orphanParty: string[]; // externalRef — ops party with no matching teacher
  moneyForArchived: string[]; // teacherId — archived but still has active money (offboard didn't fully close)
  incompleteActive: string[]; // teacherId — not archived, has party, no money (== setupIncomplete)
}

/** Pure teacher↔ops drift diff (TASK-018). */
export function reconcileTeacherDrift(
  teachers: Array<{ id: string; archived: boolean; type: string }>,
  partyRefs: Set<string>,
  budgetRefs: Set<string>,
  salaryRefs: Set<string>,
): ReconcileReport {
  const teacherIds = new Set(teachers.map((t) => t.id));
  const report: ReconcileReport = {
    missingParty: [],
    orphanParty: [],
    moneyForArchived: [],
    incompleteActive: [],
  };
  for (const t of teachers) {
    if (t.archived) {
      if (budgetRefs.has(t.id) || salaryRefs.has(t.id)) report.moneyForArchived.push(t.id);
      continue;
    }
    if (!partyRefs.has(t.id)) {
      report.missingParty.push(t.id);
      continue;
    }
    const hasMoney = t.type === "FREELANCE" ? budgetRefs.has(t.id) : salaryRefs.has(t.id);
    if (!hasMoney) report.incompleteActive.push(t.id);
  }
  for (const ref of partyRefs) if (!teacherIds.has(ref)) report.orphanParty.push(ref);
  return report;
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
