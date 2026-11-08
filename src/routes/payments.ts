import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "../lib/validate";
import * as record from "../lib/payment-record";
import { PAYMENT_METHODS, PAYMENT_REF_TYPES } from "../lib/payment-record";
import { actorOf } from "../services/user.service";

// TASK-875 (SPEC-099 §8.5) — the front-office door onto the F2 payment record. Mounted at `/api/payments` behind the guard
// (the mount line and the three `route-access.ts` entries are the SHARED hunks, added after Team B's deploy).
// The shapes are BB's `/revenue/payments` shapes exactly, so the SF and the back-office screen read the same payload:
//   GET   ?refType=COURSE|VOUCHER&refId=<uuid>  → { payments:[{id,refType,refId,n,paidOn,amountMinor,method,updatedAt}], feeMinor, paidMinor, remainingMinor }
//   POST  {refType,refId,paidOn,amountMinor,method} → 201 { payment }   (an installment, n = max + 1)
//   PATCH /:id {method?,paidOn?,amountMinor?}       → { payment }       (row 1's method also moves the revenue line, §8.4)
// Errors: 400 bad body / sum over the fee · 404 unknown payment · 409 `NO_FEE` (the sale posted no movement) / `CONFLICT` (lost race on n).

/** A real calendar date, not just the shape: `2026-02-31` is refused. */
const isRealDate = (s: string): boolean => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealDate);

export const paymentRefQuery = z.object({ refType: z.enum(PAYMENT_REF_TYPES), refId: z.string().uuid() });
export const createPaymentBody = z.object({
  refType: z.enum(PAYMENT_REF_TYPES),
  refId: z.string().uuid(),
  paidOn: DATE,
  amountMinor: z.number().int().positive(),
  method: z.enum(PAYMENT_METHODS),
});
export const patchPaymentBody = z
  .object({
    method: z.enum(PAYMENT_METHODS).optional(),
    paidOn: DATE.optional(),
    // Every row's amount is editable since §8.9 (row 1 included); the logic enforces sum(rows) <= the fee.
    amountMinor: z.number().int().positive().optional(),
  })
  .refine((b) => b.method !== undefined || b.paidOn !== undefined || b.amountMinor !== undefined, {
    message: "send at least one of method, paidOn, amountMinor",
  });
const idParam = z.object({ id: z.string().uuid() });

/** The three operations the router needs — injectable, so the route test runs without a database. */
export type PaymentOps = Pick<typeof record, "listPayments" | "addInstallment" | "patchPayment">;

export function makePaymentRoutes(ops: PaymentOps = record) {
  return new Hono()
    .get("/", zValidator("query", paymentRefQuery), async (c) => {
      const q = c.req.valid("query");
      return c.json(await ops.listPayments(q.refType, q.refId));
    })
    .post("/", zValidator("json", createPaymentBody), async (c) => c.json({ payment: await ops.addInstallment(c.req.valid("json"), actorOf(c)) }, 201))
    .patch("/:id", zValidator("param", idParam), zValidator("json", patchPaymentBody), async (c) =>
      c.json({ payment: await ops.patchPayment(c.req.valid("param").id, c.req.valid("json"), actorOf(c)) }),
    );
}

export const paymentRoutes = makePaymentRoutes();
