// TASK-066 — post a sale to backoffice as a `bo.movement`, written DIRECTLY on the shared DB.
//
// ⚠️ Why this file exists. Sales used to be POSTed to `/api/v1/catalog/items/by-ref/movements` on
// backoffice-back. That route was retired by the REQ-006 rebuild (TASK-027, deployed 2026-07-28) and
// is mounted nowhere, so every call 404'd — and because both call sites are `void recordSale(...)`,
// best-effort by design, **the failure had no voice and no sale was recorded for days**. The
// freelance ceiling has written `bo` directly via Drizzle on the shared DB throughout and never
// broke. Sales were the one flow still on the HTTP hop. Now they aren't.
//
// Two rules this file exists to hold:
//   1. It must NEVER fail the sale/booking it describes — revenue posting is downstream bookkeeping.
//   2. It must NEVER fail silently again. Every non-post is logged loudly, with the ref, at
//      console.error. Rule 1 is why this went unnoticed; rule 2 is the actual fix.

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { boItem, boMovement } from "../db/schema";
import { pgErrorCode } from "./http";
import { SALE_SOURCE, isKnownSaleItem } from "./sale-items";

/**
 * The signed shape of a sale movement. Pure, and exported so the sign rule is tested rather than
 * trusted — it has to match backoffice-back's `bo-money.ts` exactly or the P&L reads the wrong way:
 * `qty` is signed with **negative = OUT (a sale)**, and `value_minor = −qty × unit_price`, so an OUT
 * is a POSITIVE figure on an INCOME item and `SUM(value_minor)` nets sales against reversals.
 */
export function saleMovement(
  quantity: number,
  unitPriceMinor: number,
): { qty: number; valueMinor: number } {
  const qty = -Math.abs(quantity);
  return { qty, valueMinor: -qty * unitPriceMinor };
}

export interface SalePostResult {
  ok: boolean;
  /** Set when nothing was written: why. `duplicate` is a success (idempotent replay). */
  skipped?: "item-missing" | "unknown-code" | "duplicate" | "error";
}

/**
 * A course / voucher / trial was sold → record the revenue on its INCOME item.
 * `externalRef` is the product code ("course-6", "voucher-10", "first-trial", "single-session").
 *
 * Idempotent on `idempotencyKey`: re-running writes nothing extra (checked up-front, and the
 * unique index on `bo.movement.idempotency_key` catches the concurrent case).
 */
export async function recordSale(
  externalRef: string,
  quantity: number,
  opts: { refId?: string; idempotencyKey?: string } = {},
): Promise<SalePostResult> {
  const where = `ref=${externalRef} refId=${opts.refId ?? "-"}`;

  // A code with no entry in SALE_ITEMS can never have an item, so say so specifically rather than
  // letting it look like a missing-item deploy step.
  if (!isKnownSaleItem(externalRef)) {
    console.error(
      `[sale] NOT POSTED — unknown product code (${where}). It is not in lib/sale-items.ts, so no ` +
        `item exists for it. Add it there (and re-run \`bun run sale:ensure-items\`) — revenue for ` +
        `this sale is NOT in the books.`,
    );
    return { ok: false, skipped: "unknown-code" };
  }

  try {
    const item = await db.query.boItem.findFirst({
      where: (i, { and: a, eq: e }) => a(e(i.externalSource, SALE_SOURCE), e(i.externalRef, externalRef)),
    });
    if (!item) {
      console.error(
        `[sale] NOT POSTED — no bo.item for external_source=${SALE_SOURCE} (${where}). ` +
          `Run \`bun run sale:ensure-items\` — revenue for this sale is NOT in the books.`,
      );
      return { ok: false, skipped: "item-missing" };
    }

    if (opts.idempotencyKey) {
      const already = await db.query.boMovement.findFirst({
        where: (m, { eq: e }) => e(m.idempotencyKey, opts.idempotencyKey!),
      });
      if (already) return { ok: true, skipped: "duplicate" }; // replay — not an error, not a second row
    }

    const { qty, valueMinor } = saleMovement(quantity, item.unitPriceMinor);
    await db.insert(boMovement).values({
      itemId: item.id,
      qty,
      valueMinor,
      reason: "SALE",
      refType: "SALE",
      refId: opts.refId ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
    });
    return { ok: true };
  } catch (e) {
    // Lost the race on the idempotency key → the other writer posted it. That IS the desired
    // outcome, so it must not be reported as a failure; a loud false alarm would erode the very
    // signal this task adds.
    if (pgErrorCode(e) === "23505") return { ok: true, skipped: "duplicate" };
    console.error(
      `[sale] NOT POSTED — write failed (${where}). Revenue for this sale is NOT in the books:`,
      e,
    );
    return { ok: false, skipped: "error" };
  }
}
