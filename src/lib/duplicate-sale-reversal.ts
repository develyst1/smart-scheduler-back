// 🔻 TASK-750 (REQ-130) — the PURE decision behind `sale:reverse-duplicates`, a ONE-OFF, owner-run correction.
//
// Before the day-end learned to skip a row whose revenue is already live (TASK-749 reopened), every RE-RUN of a date posted its trial / 1 HR / priced-OTHER sales again as `rev:<id>#n` — the owner's 18 Oct
// re-run on uat doubled 13 sales (≈ 17,751.00 THB). The books show them in P&L / Revenue by activity / Customer spend. This decides which of a booking's sales to REVERSE, and nothing else.
//
// 🔴 THE RULE: a booking's LIVE sales = the `rev:` sales whose generation has NO `rev-undo:` of the same generation. More than one live ⇒ reverse the LOWEST live generations and keep ONLY the HIGHEST live.
// Why the highest stays: `reverseBookingSale` (a later attendance Undo) reverses `postedGeneration = revGeneration − 1` — the HIGHEST. Reversing that one here would make a later Undo hit an already-reversed key
// and leave the remaining sale in the books while the attendance is undone. Keeping the highest keeps that path whole, and `liveRevenue` is true afterwards (exactly one live) so the day-end posts nothing more.
//
// Each reversal is exactly what `reverseBookingSale` writes for that generation (the sale's item, `qty: −sale.qty`, `value_minor: −(sale + that generation's discount)`, `ref_type SALE`, `ref_id` = the booking, the key
// `revUndoKey(id, g)`), with its own reason. A net of 0 (a 100 % discount) writes nothing — a ฿0 row reads as «a sale of nothing happened». The keys come from `lib/sale-post.ts`; they are not re-spelled here.
import { discountKey, revKey, revUndoKey } from "./sale-post";

/** The first day a duplicate could exist: the day TASK-258 (`a1b06ff`) made every re-posting key a fresh one. A booking dated before it cannot have been doubled this way. */
export const DUPLICATE_SALE_FLOOR = "2026-09-06";
/** The ledger text of a correction made here (the one text column `bo.movement` has). */
export const DUPLICATE_REVERSAL_REASON = "REVERSAL — duplicate day-end re-run";

/** One `bo.movement` row of a booking that matters here: its idempotency key (`rev:` / `rev-undo:` / `discount:` family), item, qty and value. */
export interface LedgerRow { idempotencyKey: string; itemId: string; qty: number; valueMinor: number }
/** A ledger row with the booking it belongs to (and that booking's date and type, for the floor and the report). */
export interface BookingLedgerRow extends LedgerRow { bookingId: string; date: string; bookingType: string }

export interface PlannedReversal {
  bookingId: string;
  generation: number;
  itemId: string;
  qty: number;
  valueMinor: number;
  reason: string;
  refType: "SALE";
  idempotencyKey: string;
}
export interface BookingPlan { bookingId: string; date: string; bookingType: string; reversals: PlannedReversal[]; netMinor: number }

/** The reversals ONE booking needs, from its own ledger rows. Pure. */
export function planDuplicateReversals(bookingId: string, rows: readonly LedgerRow[]): PlannedReversal[] {
  const byKey = new Map(rows.map((r) => [r.idempotencyKey, r]));
  // generations are 0..n−1 in practice; scanning up to `rows.length` finds every one even across a gap
  const live: number[] = [];
  for (let g = 0; g <= rows.length; g++) {
    if (byKey.has(revKey(bookingId, g)) && !byKey.has(revUndoKey(bookingId, g))) live.push(g);
  }
  if (live.length <= 1) return []; // nothing doubled (or already corrected)
  const out: PlannedReversal[] = [];
  for (const g of live.slice(0, -1)) { // the LOWEST live ones; the highest stays
    const sale = byKey.get(revKey(bookingId, g))!;
    const net = sale.valueMinor + (byKey.get(discountKey(bookingId, g))?.valueMinor ?? 0);
    if (net === 0) continue; // fully discounted: nothing to give back
    out.push({ bookingId, generation: g, itemId: sale.itemId, qty: -sale.qty, valueMinor: -net, reason: DUPLICATE_REVERSAL_REASON, refType: "SALE", idempotencyKey: revUndoKey(bookingId, g) });
  }
  return out;
}

/** Every booking dated on/after `floor`, grouped and planned; only bookings that need a reversal are returned, oldest first. */
export function planAll(rows: readonly BookingLedgerRow[], floor: string = DUPLICATE_SALE_FLOOR): BookingPlan[] {
  const groups = new Map<string, BookingLedgerRow[]>();
  for (const r of rows) {
    if (r.date < floor) continue;
    groups.set(r.bookingId, [...(groups.get(r.bookingId) ?? []), r]);
  }
  const plans: BookingPlan[] = [];
  for (const [bookingId, g] of groups) {
    const reversals = planDuplicateReversals(bookingId, g);
    if (!reversals.length) continue;
    plans.push({ bookingId, date: g[0]!.date, bookingType: g[0]!.bookingType, reversals, netMinor: reversals.reduce((s, r) => s - r.valueMinor, 0) });
  }
  return plans.sort((a, b) => a.date.localeCompare(b.date) || a.bookingId.localeCompare(b.bookingId));
}

const baht = (minor: number) => (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

/** The review gate before a live money write: one line per booking (id · date · type · generations reversed · net THB), then the count and the total. IDS and AMOUNTS only — no names. */
export function formatDuplicatePlan(plans: readonly BookingPlan[]): string {
  const lines = plans.map((p) => `    ↩︎ ${p.bookingId} · ${p.date} · ${p.bookingType} · รุ่น ${p.reversals.map((r) => r.generation).join(",")} · ${baht(p.netMinor)} บาท`);
  const total = plans.reduce((s, p) => s + p.netMinor, 0);
  return [`  ต้องกลับรายการ ${plans.length} การจอง · รวม ${baht(total)} บาท`, ...lines].join("\n");
}
