// SPEC-099 §8 / TASK-875 — the F2 payment record, SB side: the auto row at a course / voucher sale, and the front-office
// API's logic (list · add an installment · patch). `bo.payment` is BB's table (TASK-874, migration 0012); BB has the same
// rules for the back-office screen. This file is the SB TWIN: the pure helpers below are pinned by a test to the exact
// key formats BB uses (golden vectors in `payment-record.test.ts`), because the two repos cannot share a module.
//
// Rules held here:
//   1. `createSalePayment` NEVER fails the sale it describes (best-effort) and NEVER fails silently (console.error).
//   2. Money is integer satang. Installments SPLIT the sale's fee (§8.9): sum(rows) <= fee, every row's amount editable.
//   3. The fee is READ from the posted movements (`course-sale:<id>` / `voucher-sale:<id>` + `discount:<id>`), never guessed.
//   4. Everything that touches one sale's payments takes one advisory lock for that sale (released at commit).
//   5. Row 1's METHOD edit moves the revenue line's method IN THE SAME TRANSACTION (§8.4); installments never do.
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { boMovement } from "../db/schema";
import { boPayment, boRevenueLine } from "../db/bo-revenue";
import { badRequest, conflict, notFound, pgErrorCode } from "./http";
import { bangkokNow } from "./bangkok-time";

export const PAYMENT_REF_TYPES = ["COURSE", "VOUCHER"] as const;
export type PaymentRefType = (typeof PAYMENT_REF_TYPES)[number];
export const PAYMENT_METHODS = ["TRANSFER", "CASH", "CARD"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// ───────────────────────────────── pure rules (twins of BB `lib/revenue-ledger.ts`) ─────────────────────────────────
export function feeKeys(refType: PaymentRefType, refId: string): { sale: string; discount: string } {
  return { sale: `${refType === "COURSE" ? "course-sale" : "voucher-sale"}:${refId}`, discount: `discount:${refId}` };
}
/** The fee = the sale movement + the (negative) discount movement; `null` when the sale movement is not there. */
export function feeFromMovements(refType: PaymentRefType, refId: string, rows: readonly { key: string | null; valueMinor: number }[]): number | null {
  const k = feeKeys(refType, refId);
  if (!rows.some((r) => r.key === k.sale)) return null;
  return rows.filter((r) => r.key === k.sale || r.key === k.discount).reduce((n, r) => n + r.valueMinor, 0);
}
/** The revenue line a payment's method follows (TASK-864 writes `rl:course:<id>` / `rl:voucher:<id>`). */
export const revenueLineKeyFor = (refType: PaymentRefType, refId: string): string => `rl:${refType.toLowerCase()}:${refId}`;
/** §8.4: only an edit of ROW 1's method moves the line. */
export const followsRevenueLine = (n: number, patch: { method?: string; paidOn?: string; amountMinor?: number }): boolean => n === 1 && patch.method !== undefined;
/** §8.9: the sum of the rows may never exceed the fee. */
export const installmentsFit = (feeMinor: number, rowsMinor: readonly number[]): boolean => rowsMinor.reduce((a, b) => a + b, 0) <= feeMinor;
export function paymentTotals(feeMinor: number | null, rowsMinor: readonly number[]): { feeMinor: number | null; paidMinor: number; remainingMinor: number | null } {
  const paidMinor = rowsMinor.reduce((a, b) => a + b, 0);
  return { feeMinor, paidMinor, remainingMinor: feeMinor === null ? null : feeMinor - paidMinor };
}

// ─────────────────────────────────────────────────── DTO and helpers ───────────────────────────────────────────────────
export type PaymentDTO = {
  id: string;
  refType: string;
  refId: string;
  n: number;
  paidOn: string;
  amountMinor: number;
  method: string;
  updatedAt: string;
};
const toDTO = (r: typeof boPayment.$inferSelect): PaymentDTO => ({
  id: r.id,
  refType: r.refType,
  refId: r.refId,
  n: r.n,
  paidOn: r.paidOn,
  amountMinor: r.amountMinor,
  method: r.method,
  updatedAt: (r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt)).toISOString(),
});

async function lockRef(tx: any, refType: string, refId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`payment:${refType}:${refId}`}))`);
}
const overFee = (refType: string) => badRequest(`the installments add up to more than the ${refType === "VOUCHER" ? "voucher" : "course"} fee`);

/** The sale's fee from its posted movements; `null` when the sale movement is absent. */
export async function feeOf(d: any, refType: PaymentRefType, refId: string): Promise<number | null> {
  const k = feeKeys(refType, refId);
  const rows: { key: string | null; valueMinor: number }[] = await d
    .select({ key: boMovement.idempotencyKey, valueMinor: boMovement.valueMinor })
    .from(boMovement)
    .where(inArray(boMovement.idempotencyKey, [k.sale, k.discount]));
  return feeFromMovements(refType, refId, rows);
}

// ───────────────────────────────────────────────────── the auto row ─────────────────────────────────────────────────────
export interface SalePaymentResult {
  ok: boolean;
  /** Set when nothing was written. `duplicate` is a success (row 1 was already there). */
  skipped?: "duplicate" | "bad-amount" | "error";
}

/**
 * The sale's own payment: row `n = 1`, `paid_on` = the Bangkok date of the sale, `amount` = the net the sale posted,
 * `method = TRANSFER` (the SF sets another method with a PATCH right after, TASK-876). `ON CONFLICT DO NOTHING` on
 * `(ref_type, ref_id, n)`: a replayed sale leaves exactly one row. Never throws.
 */
export async function createSalePayment(
  refType: PaymentRefType,
  refId: string,
  amountMinor: number,
  d: any = db,
  paidOn: string = bangkokNow().date,
): Promise<SalePaymentResult> {
  const tag = `payment:${refType}:${refId}`;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    console.error(`[payment] NOT WRITTEN — ${tag}: amount must be a positive integer in satang, got ${amountMinor}. This sale has no payment row.`);
    return { ok: false, skipped: "bad-amount" };
  }
  try {
    const inserted = await d
      .insert(boPayment)
      .values({ refType, refId, n: 1, paidOn, amountMinor, method: "TRANSFER", actor: null })
      .onConflictDoNothing({ target: [boPayment.refType, boPayment.refId, boPayment.n] })
      .returning({ id: boPayment.id });
    return inserted.length ? { ok: true } : { ok: true, skipped: "duplicate" };
  } catch (e) {
    console.error(`[payment] NOT WRITTEN — write failed (${tag}). This sale has no payment row:`, e);
    return { ok: false, skipped: "error" };
  }
}

// ───────────────────────────────────────────────────── the API logic ────────────────────────────────────────────────────
/** `GET`: rows by n, plus the fee, what is paid and what remains. */
export async function listPayments(refType: PaymentRefType, refId: string, d: any = db) {
  const rows: (typeof boPayment.$inferSelect)[] = await d
    .select()
    .from(boPayment)
    .where(and(eq(boPayment.refType, refType), eq(boPayment.refId, refId)))
    .orderBy(asc(boPayment.n));
  const fee = await feeOf(d, refType, refId);
  return { payments: rows.map(toDTO), ...paymentTotals(fee, rows.map((r) => r.amountMinor)) };
}

/** `POST`: installment `n = max + 1`. No fee → 409 `NO_FEE`; sum over the fee → 400; a lost race on n → 409. */
export async function addInstallment(
  input: { refType: PaymentRefType; refId: string; paidOn: string; amountMinor: number; method: PaymentMethod },
  actor: string | null,
  d: any = db,
): Promise<PaymentDTO> {
  return d.transaction(async (tx: any) => {
    await lockRef(tx, input.refType, input.refId);
    const fee = await feeOf(tx, input.refType, input.refId);
    if (fee === null) throw conflict("NO_FEE", "this sale has no posted fee, so there is nothing to split into installments");
    const rows: { n: number; amountMinor: number }[] = await tx
      .select({ n: boPayment.n, amountMinor: boPayment.amountMinor })
      .from(boPayment)
      .where(and(eq(boPayment.refType, input.refType), eq(boPayment.refId, input.refId)));
    if (!installmentsFit(fee, [...rows.map((r) => r.amountMinor), input.amountMinor])) throw overFee(input.refType);
    const n = Math.max(0, ...rows.map((r) => r.n)) + 1;
    try {
      const [row] = await tx
        .insert(boPayment)
        .values({ refType: input.refType, refId: input.refId, n, paidOn: input.paidOn, amountMinor: input.amountMinor, method: input.method, actor })
        .returning();
      return toDTO(row);
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw conflict("CONFLICT", "another payment took this installment number; try again");
      throw e;
    }
  });
}

/** `PATCH`: method / paidOn / amountMinor of any row (§8.9: row 1's amount too). Row 1's method also moves the revenue line (§8.4). */
export async function patchPayment(
  id: string,
  patch: { method?: PaymentMethod; paidOn?: string; amountMinor?: number },
  actor: string | null,
  d: any = db,
): Promise<PaymentDTO> {
  return d.transaction(async (tx: any) => {
    const [found] = await tx.select().from(boPayment).where(eq(boPayment.id, id)).limit(1);
    if (!found) throw notFound("payment not found");
    await lockRef(tx, found.refType, found.refId);
    // re-read under the lock: another writer may have changed it between the first read and the lock
    const [cur] = await tx.select().from(boPayment).where(eq(boPayment.id, id)).limit(1);
    if (!cur) throw notFound("payment not found");

    if (patch.amountMinor !== undefined) {
      const fee = await feeOf(tx, cur.refType as PaymentRefType, cur.refId);
      if (fee === null) throw conflict("NO_FEE", "this sale has no posted fee, so an amount cannot be checked against it");
      const others: { amountMinor: number }[] = await tx
        .select({ amountMinor: boPayment.amountMinor })
        .from(boPayment)
        .where(and(eq(boPayment.refType, cur.refType), eq(boPayment.refId, cur.refId), ne(boPayment.id, cur.id)));
      if (!installmentsFit(fee, [...others.map((r) => r.amountMinor), patch.amountMinor])) throw overFee(cur.refType);
    }

    const [row] = await tx
      .update(boPayment)
      .set({
        ...(patch.method !== undefined ? { method: patch.method } : {}),
        ...(patch.paidOn !== undefined ? { paidOn: patch.paidOn } : {}),
        ...(patch.amountMinor !== undefined ? { amountMinor: patch.amountMinor } : {}),
        actor,
        updatedAt: new Date(),
      })
      .where(eq(boPayment.id, id))
      .returning();

    if (followsRevenueLine(cur.n, patch)) {
      await tx
        .update(boRevenueLine)
        .set({ method: patch.method })
        .where(eq(boRevenueLine.idempotencyKey, revenueLineKeyFor(cur.refType as PaymentRefType, cur.refId)));
    }
    return toDTO(row);
  });
}
