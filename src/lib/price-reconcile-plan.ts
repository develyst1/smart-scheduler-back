// SPEC-058 / TASK-158 Part B (REQ-061) — the PURE decision behind `sale:reconcile-prices`.
//
// `sale:ensure-items` is insert-only, deliberately: it must never overwrite a price a human set. That leaves a
// gap — when the CATALOGUE changes (a card correction, like onewheel 6 h 7,990 → 7,900), the stored `bo.item`
// keeps the old number and every future sale posts it. The drift has now bitten twice.
//
// This is the "update half": compare each catalogue price to what is stored, change only the mismatches, and
// show every one of them before writing. It is safe as the source of truth precisely because it was verified
// that no box holds hand-set or placeholder prices — if that ever stops being true, this tool's dry run is where
// it must be caught, which is why the dry run lists every change with both numbers.
import { SALE_ITEMS, type SaleItemSeed } from "./sale-items";

export interface StoredItem {
  externalRef: string;
  name: string;
  unitPriceMinor: number;
}

export interface PriceChange {
  externalRef: string;
  name: string;
  from: number;
  to: number;
}

export interface ReconcilePlan {
  /** Stored price differs from the catalogue ⇒ would be updated. */
  changes: PriceChange[];
  /** Present and already correct. */
  matching: string[];
  /** In the catalogue but not in `bo.item` — `sale:ensure-items`' job, NOT this tool's. */
  missing: string[];
  /** Stored under our source but no longer in the catalogue — reported, never deleted. */
  orphans: string[];
}

export function planPriceReconcile(stored: readonly StoredItem[], catalogue: readonly SaleItemSeed[] = SALE_ITEMS): ReconcilePlan {
  const byRef = new Map(stored.map((s) => [s.externalRef, s]));
  const changes: PriceChange[] = [];
  const matching: string[] = [];
  const missing: string[] = [];

  for (const item of catalogue) {
    const s = byRef.get(item.externalRef);
    if (!s) {
      // Creating is `ensure-items`' job. Doing it here too would give two tools one responsibility.
      missing.push(item.externalRef);
      continue;
    }
    if (s.unitPriceMinor !== item.unitPriceMinor) {
      changes.push({ externalRef: item.externalRef, name: item.name, from: s.unitPriceMinor, to: item.unitPriceMinor });
    } else matching.push(item.externalRef);
  }

  const catalogueRefs = new Set(catalogue.map((i) => i.externalRef));
  // A retired code still has posted movements pointing at it — reported so it is visible, never deleted here.
  const orphans = stored.filter((s) => !catalogueRefs.has(s.externalRef)).map((s) => s.externalRef);

  return { changes, matching, missing, orphans };
}

const baht = (minor: number) => (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

/** Every change with BOTH numbers — this listing is the review gate before a live money edit. */
export function formatReconcilePlan(p: ReconcilePlan): string {
  const lines = [
    `  ตรงกันแล้ว ${p.matching.length} · ต้องแก้ราคา ${p.changes.length} · ยังไม่มีในระบบ ${p.missing.length} · ไม่มีในแค็ตตาล็อกแล้ว ${p.orphans.length}`,
  ];
  for (const c of p.changes) lines.push(`    ✏️ ${c.externalRef} (${c.name}): ${baht(c.from)} → ${baht(c.to)} บาท`);
  for (const m of p.missing) lines.push(`    ➕ ${m} — ยังไม่มี ให้รัน \`sale:ensure-items\` ก่อน`);
  for (const o of p.orphans) lines.push(`    ⚠️ ${o} — ไม่มีในแค็ตตาล็อกแล้ว (ไม่ลบ, แจ้งให้ทราบ)`);
  return lines.join("\n");
}
