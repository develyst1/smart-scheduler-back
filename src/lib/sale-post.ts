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

import { and, eq, like, or } from "drizzle-orm";
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

// ─────── SPEC-073 / TASK-258 (REQ-083) — a booking's revenue is a SEQUENCE, not one fact ───────
//
// 🔴 The key was `rev:<bookingId>`, fixed for the life of the booking. That is right until an attendance is
// undone and re-marked: the second posting hits the duplicate check and `recordSale` returns
// `{ ok: true, skipped: "duplicate" }` — **it reports success and writes nothing** (AC-8).
//
// A reversal key alone cannot fix it: AC-7 wants the *reversal* idempotent, AC-8 wants the *posting* repeatable —
// opposite demands on one key. ⇒ both keys carry a **generation** `n` = the number of postings this booking has
// already had. Same `n` ⇒ same key ⇒ a replay is still skipped; `n+1` ⇒ a fresh key ⇒ the re-post writes.
// 🚫 No column: `n` is derived from the movements themselves — where the duplicate check already looks.
//
// 🔴 **Generation 0 is the UN-SUFFIXED key**, byte for byte what every historical row carries. Get that wrong
// and every booking ever posted reads as unposted, and the next day-end posts it a second time.

/** `rev:<bookingId>` at generation 0, `rev:<bookingId>#<n>` after that. */
export const revKey = (bookingId: string, generation = 0): string =>
  generation === 0 ? `rev:${bookingId}` : `rev:${bookingId}#${generation}`;

/** The reversal OF the posting of the same generation — the same rule, so the pair always reads as a pair. */
export const revUndoKey = (bookingId: string, generation = 0): string =>
  generation === 0 ? `rev-undo:${bookingId}` : `rev-undo:${bookingId}#${generation}`;

/**
 * The discount rides its sale, so it has to follow it: a re-posted sale needs a re-posted discount, or the
 * second posting nets the LIST price and the books over-charge the family by exactly the discount.
 * ⚠️ Generation 0 is `discount:<refId>` — the string `discount-plan.ts` has always written.
 */
export const discountKey = (refId: string, generation = 0): string =>
  generation === 0 ? `discount:${refId}` : `discount:${refId}#${generation}`;

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
    /**
     * TASK-258 — the discount's own key, when the caller is posting a later GENERATION of this booking's
     * revenue. Omitted ⇒ `discount:<refId>`, exactly as before. Without it a re-posted sale would carry no
     * discount (the fixed key is already taken) and the books would over-charge by the discount.
     */
    discountKey?: string;
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
        // TASK-258 — the discount follows its sale's generation. Default (undefined) leaves
        // `discountMovement`'s own `discount:<refId>` in place, so nothing about a first posting changes.
        ...(opts.discountKey ? { idempotencyKey: opts.discountKey } : {}),
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

// ─────── SPEC-070 / TASK-225 (REQ-078) — posting a sale BY ITEM ID, with an explicit amount ───────
//
// ⚠️ Why this is a sibling and not a flag on `recordSale`. That function resolves the item from a **product
// code** in `SALE_ITEMS` (`external_source = 'smart-scheduler'` + `external_ref`) and takes the amount from the
// item's `unit_price_minor`. An อื่นๆ charge has neither: a **typed amount** has no product code, and a
// **backoffice catalogue item** has no `external_source = 'smart-scheduler'`. Bending `recordSale` to accept
// "sometimes an id, sometimes a code, sometimes a price, sometimes not" would put four combinations through the
// one function that must never fail a booking. So: same rules, same idempotency shape, different entry point.
//
// The two rules of this file are unchanged and apply here identically:
//   1. It must NEVER fail the booking it describes.
//   2. It must NEVER fail silently — every non-post is `console.error` with the ref.

/**
 * Post one sale to an explicit `bo.item`, for an explicit amount.
 *
 * 🔴 **Sign:** `qty = -1` (an OUT), `value_minor = +amountMinor`. Positive, exactly as `saleMovement` produces
 * for a coded sale, so `SUM(value_minor)` nets sales against reversals the same way (`bo-money.ts:17`). A
 * flipped sign here is invisible until a month-end number does not add up, so it is pinned in a test.
 *
 * Idempotent on `idempotencyKey` with the **same** up-front-read + unique-index shape `recordSale` uses — one
 * idempotency pattern in this codebase, not two.
 */
export async function postBookingSale(opts: {
  itemId: string;
  amountMinor: number;
  refId: string;
  idempotencyKey: string;
}): Promise<SalePostResult> {
  const where = `item=${opts.itemId} refId=${opts.refId}`;

  // A charge of nothing is not a charge. The caller (`jobs.service.ts`) already declines to call for an
  // uncharged booking — AC-4 is "no movement at all", never a ฿0 row — so reaching here with 0 or less is a
  // bug upstream, and it says so rather than writing a row that reads as a sale that happened.
  if (!Number.isInteger(opts.amountMinor) || opts.amountMinor <= 0) {
    console.error(
      `[sale] NOT POSTED — amount must be a positive integer in satang, got ${opts.amountMinor} (${where}). ` +
        `Revenue for this booking is NOT in the books.`,
    );
    return { ok: false, skipped: "error" };
  }

  try {
    const item = await db.query.boItem.findFirst({ where: (i, { eq: e }) => e(i.id, opts.itemId) });
    // TASK-066's lesson, in the shape this task needs it: a chosen catalogue item that has been deleted or
    // deactivated since the booking was made must post NOTHING and say so. 🚫 Never fall back to a default
    // price — an invented number in the books is worse than a missing one, because nobody goes looking for it.
    if (!item || !item.active) {
      console.error(
        `[sale] NOT POSTED — the chosen catalogue item is ${item ? "INACTIVE" : "missing"} (${where}). ` +
          `Revenue for this booking is NOT in the books; no fallback price was invented.`,
      );
      return { ok: false, skipped: "item-missing" };
    }

    const already = await db.query.boMovement.findFirst({
      where: (m, { eq: e }) => e(m.idempotencyKey, opts.idempotencyKey),
    });
    if (already) return { ok: true, skipped: "duplicate" }; // replay — not an error, not a second row

    await db.insert(boMovement).values({
      itemId: item.id,
      qty: -1, // OUT — one booking sold
      valueMinor: opts.amountMinor, // positive; the amount is the caller's, never the item's price
      reason: "SALE",
      refType: "SALE",
      refId: opts.refId,
      idempotencyKey: opts.idempotencyKey,
    });
    return { ok: true };
  } catch (e) {
    // Lost the race on the key → the other writer posted it. That IS the desired outcome, so it must not be
    // reported as a failure (the same reasoning as `recordSale`'s catch).
    if (pgErrorCode(e) === "23505") return { ok: true, skipped: "duplicate" };
    console.error(
      `[sale] NOT POSTED — write failed (${where}). Revenue for this booking is NOT in the books:`,
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
  // 🔴 TASK-258 — read the CURRENT generation once, and use it for both halves. After an undo-and-re-attend the
  // live sale is `rev:<id>#1`; reading the fixed key would tell an admin "no money posted" about a booking that
  // has just been charged — the exact defect SPEC-069 exists to close, one generation along.
  const generation = await postedGeneration(bookingId);
  const [sale] = await db
    .select({
      valueMinor: boMovement.valueMinor,
      createdAt: boMovement.createdAt,
      productCode: boItem.externalRef,
    })
    .from(boMovement)
    .innerJoin(boItem, eq(boItem.id, boMovement.itemId))
    .where(eq(boMovement.idempotencyKey, revKey(bookingId, generation)))
    .limit(1);
  if (!sale) return null;

  // The discount rides the SAME sale (same item, same refId) — `lib/discount-plan.ts`. A discounted trial must
  // not warn with the list price, and it follows the sale's generation for the same reason the sale does.
  const discount = await db.query.boMovement.findFirst({
    where: (m, { eq: e }) => e(m.idempotencyKey, discountKey(bookingId, generation)),
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

// ─────── SPEC-073 / TASK-258 (REQ-083) — the generation, and the reversal ───────

/**
 * How many times this booking's revenue has been posted — `n` for the NEXT posting, and the count of
 * `rev:` movements it already has.
 *
 * Derived from the ledger, never stored: the movements are already the source of truth the duplicate check
 * reads, and a counter column would be a second one that can disagree with it. Generation 0's key is the
 * un-suffixed `rev:<bookingId>`, so a booking posted before this task counts as exactly one.
 */
export async function revGeneration(bookingId: string): Promise<number> {
  const rows = await db
    .select({ key: boMovement.idempotencyKey })
    .from(boMovement)
    .where(
      or(
        eq(boMovement.idempotencyKey, revKey(bookingId, 0)),
        like(boMovement.idempotencyKey, `rev:${bookingId}#%`),
      ),
    );
  return rows.length;
}

/** The generation of the posting that is CURRENTLY live — `revGeneration - 1`, or 0 when nothing was posted. */
export async function postedGeneration(bookingId: string): Promise<number> {
  return Math.max(0, (await revGeneration(bookingId)) - 1);
}

/**
 * REQ-083 AC-5/AC-6/AC-7 — reverse the revenue an attendance posted.
 *
 * 🔴 **A NEW movement of −฿X. The original row is never edited and never deleted** (AC-9): the ledger keeps
 * "posted, then reversed" as two facts, which is what makes the history legible afterwards.
 * 🔴 **Posted nothing ⇒ writes nothing — not a ฿0 row** (AC-6). The condition is *"did THIS attendance post?"*,
 * asked of the movements. 🚫 Never a booking-type list: a course or a voucher posts at SALE time, so it has no
 * `rev:` movement and needs no reversal — that falls out of the ledger rather than out of a list that can drift.
 * 🔴 **Idempotent** (AC-7): the reversal carries `rev-undo:<id>#<n>` for the generation it reverses, so running
 * it twice writes one row.
 *
 * ⚠️ It reverses the **NET** — the sale plus its discount — because that is what was actually taken and what
 * `postedSaleForBooking` shows the admin. Reversing the list price alone would refund money nobody was charged.
 *
 * Best-effort like everything else in this file: a correction to a booking must never fail because bookkeeping
 * did, and a non-post is loud rather than silent.
 */
export async function reverseBookingSale(bookingId: string): Promise<SalePostResult> {
  try {
    const generation = await postedGeneration(bookingId);
    const [sale] = await db
      .select()
      .from(boMovement)
      .where(eq(boMovement.idempotencyKey, revKey(bookingId, generation)))
      .limit(1);
    // AC-6 — nothing was posted for this attendance, so nothing is reversed. Not a zero row: a ฿0 movement
    // reads as "a sale of nothing happened", which is a different and false claim.
    if (!sale) return { ok: true, skipped: "duplicate" };

    const discount = await db.query.boMovement.findFirst({
      where: (m, { eq: e }) => e(m.idempotencyKey, discountKey(bookingId, generation)),
    });
    const netMinor = sale.valueMinor + (discount?.valueMinor ?? 0);
    if (netMinor === 0) return { ok: true, skipped: "duplicate" }; // fully discounted: nothing to give back

    await db.insert(boMovement).values({
      itemId: sale.itemId,
      // The mirror of the sale: it sold one unit OUT (`qty: -1`), so the reversal brings one back IN.
      qty: -sale.qty,
      valueMinor: -netMinor,
      // REQ-083's ledger wording, in the one text column `bo.movement` has. 📌 There is no `note` column here —
      // `discountMovement` returns one and it is silently dropped by the spread; naming that so the next reader
      // does not go looking for it in the books.
      reason: "REVERSAL — attendance undone",
      refType: "SALE",
      refId: bookingId,
      idempotencyKey: revUndoKey(bookingId, generation),
    });
    return { ok: true };
  } catch (e) {
    // A second reversal loses the race on the unique key — that IS the desired outcome (AC-7), so it is not
    // reported as a failure.
    if (pgErrorCode(e) === "23505") return { ok: true, skipped: "duplicate" };
    console.error(
      `[sale] NOT REVERSED — the attendance undo for booking ${bookingId} did not write its reversal. ` +
        `The original posting is STILL in the books:`,
      e,
    );
    return { ok: false, skipped: "error" };
  }
}
