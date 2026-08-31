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
import { discountMovement } from "./discount-plan";

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
  opts: {
    refId?: string;
    idempotencyKey?: string;
    /** TASK-160: an ALREADY-VALIDATED discount (see `planDiscount`) to post alongside this sale. */
    discount?: { discountMinor: number; reason: string; actor?: string | null };
  } = {},
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

    // SPEC-059 / TASK-160 (REQ-063): the discount rides the SAME seam as the sale it reduces — same item, same
    // refId — which is what makes it net its own sport in the revenue report (TASK-159) with no attribution
    // special case. It is posted AFTER the list-price movement, which is left exactly as it was (AC-7).
    //
    // ⚠️ The amount was already validated and computed by the CALLER, before anything was written: an invalid
    // discount must refuse the whole sale, and this function's first rule is that it can never fail a sale. So
    // validation lives at the boundary and only the posting lives here.
    if (opts.discount && opts.refId) {
      await db.insert(boMovement).values({
        itemId: item.id,
        ...discountMovement({
          refId: opts.refId,
          discountMinor: opts.discount.discountMinor,
          actor: opts.discount.actor ?? null,
          reason: opts.discount.reason,
        }),
      });
    }
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

// ─────── SPEC-069 / TASK-221 — the READ side: was this booking's revenue already posted? ───────
//
// Cancelling an ATTENDED `FIRST_TRIAL` / `SINGLE_SESSION` fixes the schedule, releases the freelance hold and
// returns the quota — and leaves the day-end sale in the books, silently. This read is what lets the cancel
// dialog say so, with the number. **It writes nothing, and it adds no way to move money**: reversal stays a
// backoffice act (the owner's line, held twice — REQ-036 and the `ADMIN_ERROR` course cancels).
//
// 🔴 It reports what was POSTED, never that the money is *still* there. A reversal is a manual movement that
// carries no `refId` (backoffice `bo.service.ts:58`), so it is not attributable to the booking it undoes —
// claiming "still in the books" would invite a SECOND reversal. See SPEC-069 §Limitation.

export interface PostedSale {
  /** NET satang actually in the books for this booking: `listMinor + discountMinor`. */
  amountMinor: number;
  /** The sale movement alone, before any discount. POSITIVE — see `saleMovement`. */
  listMinor: number;
  /** The discount movement's own `value_minor`, so it is **NEGATIVE** when there was one, `0` when there was
   *  not. Kept in the movement's own sign so the netting below is the same addition the P&L does
   *  (backoffice `bo-money.ts:17`) rather than a second, subtly different rule.
   *  ⚠️ Consumers render `amountMinor`; re-deriving it as `listMinor - discountMinor` yields a HIGHER number
   *  than the truth, on a warning whose whole job is the number (SA ruling, TASK-221 → TASK-222). */
  discountMinor: number;
  /** `bo.item.external_ref` — the product code ("first-trial", "single-session", …). */
  productCode: string;
  /** When the sale movement was written, ISO. */
  postedAt: string;
}

/**
 * Net a sale and its optional discount into what is actually in the books. **Pure**, and exported so the sign
 * rule is tested rather than trusted: this is the file where a flipped sign stays invisible until month end.
 *
 * `amountMinor = list + discount` — a subtraction written as the addition of a negative, exactly as the P&L
 * nets OUT against reversal IN.
 */
export function netPostedSale(input: {
  listMinor: number;
  discountMinor: number;
  productCode: string;
  postedAt: Date;
}): PostedSale {
  return {
    amountMinor: input.listMinor + input.discountMinor,
    listMinor: input.listMinor,
    discountMinor: input.discountMinor,
    productCode: input.productCode,
    postedAt: input.postedAt.toISOString(),
  };
}

/**
 * The sale posted for one booking, or `null` if there is none.
 *
 * 🔴 Found by **`idempotency_key = 'rev:<bookingId>'`** — the key the day-end job actually writes
 * (`jobs.service.ts`). Never inferred from `bookingType` / `status` / `date`: a type list here would be a
 * second copy of a rule that lives in the posting job, and the two would drift.
 *
 * A `COURSE_PACKAGE` or `VOUCHER` booking returns `null` **by construction** — those post at sale time, keyed
 * on the course/voucher, not on any booking. That is the design, not an omission.
 *
 * 🔴 **This function does not catch.** Everywhere else in this file a sale operation is best-effort, because it
 * must never fail the booking it describes. Here the opposite is true: **this read IS the warning**, and an
 * error swallowed into `null` renders as "no money posted" — the exact defect SPEC-069 exists to close. Let it
 * throw; the caller turns it into a visible "could not verify".
 */
export async function postedSaleForBooking(bookingId: string): Promise<PostedSale | null> {
  const [sale] = await db
    .select({
      valueMinor: boMovement.valueMinor,
      createdAt: boMovement.createdAt,
      productCode: boItem.externalRef,
    })
    .from(boMovement)
    .innerJoin(boItem, eq(boItem.id, boMovement.itemId))
    .where(eq(boMovement.idempotencyKey, `rev:${bookingId}`))
    .limit(1);
  if (!sale) return null;

  // The discount rides the SAME sale (same item, same refId), keyed `discount:<refId>` where refId is the
  // booking — `lib/discount-plan.ts`. A discounted trial must not warn with the list price.
  const discount = await db.query.boMovement.findFirst({
    where: (m, { eq: e }) => e(m.idempotencyKey, `discount:${bookingId}`),
  });

  return netPostedSale({
    listMinor: sale.valueMinor,
    discountMinor: discount?.valueMinor ?? 0,
    // `external_ref` is nullable on the table but never null on a sale item (that is what `recordSale` looks
    // the item up BY). Falling back to "" rather than asserting keeps a data oddity from throwing a warning away.
    productCode: sale.productCode ?? "",
    postedAt: sale.createdAt,
  });
}
