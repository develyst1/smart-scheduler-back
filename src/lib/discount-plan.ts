// SPEC-059 / TASK-160 + TASK-162 (REQ-063) — the PURE discount rule, shared by both moments.
//
// A discount is money taken off a sale a customer is standing in front of, so the rule this file exists to make
// provable is **refuse, never clamp**: a 120% discount, or ฿9,000 off a ฿7,900 course, is a mistake being typed —
// silently capping it at the price would post a sale of zero and look deliberate in the books forever. Nothing is
// written unless the whole thing validates.
//
// Used by BOTH moments — at-sale (course · voucher · rental) and day-end (1st Trial · single session) — so there
// is exactly one definition of what a valid discount is, and one rounding rule.

import { ApiException } from "./http";

export type DiscountKind = "PERCENT" | "BAHT";

export interface DiscountInput {
  kind: DiscountKind;
  /** PERCENT: 0–100. BAHT: **minor units** (satang), like every other money value in this codebase. */
  value: number;
  /** 🔴 The LINE TOTAL, not the unit price. A rental posts `qty = hours`, so its line is `hours × rate` — a ฿500
   *  discount on a 3-hour ฿600 rental is valid, and validating it against the ฿200 rate would wrongly refuse. */
  fullMinor: number;
  /** Free text, required: a discount with no stated reason is unauditable (AC-3). */
  reason: string;
}

export interface DiscountPlan {
  ok: boolean;
  /** Positive minor units to take off. The movement stores it negated. `0` when the plan is refused. */
  discountMinor: number;
  problems: string[];
}

/** Round half-up on minor units — stated explicitly so 10% of 7,905 is 791 (not 790) every time, everywhere. */
export const percentOf = (fullMinor: number, pct: number): number => Math.round((fullMinor * pct) / 100);

export function planDiscount(input: DiscountInput): DiscountPlan {
  const problems: string[] = [];
  const reason = (input.reason ?? "").trim();
  if (!reason) problems.push("ต้องระบุเหตุผลของส่วนลด");

  if (!Number.isFinite(input.value)) problems.push("ค่าส่วนลดไม่ถูกต้อง");
  if (!Number.isFinite(input.fullMinor) || input.fullMinor <= 0) problems.push("ราคาตั้งต้นไม่ถูกต้อง");

  let discountMinor = 0;
  if (input.kind === "PERCENT") {
    if (!(input.value > 0 && input.value <= 100)) problems.push("ส่วนลดเป็นเปอร์เซ็นต์ต้องอยู่ระหว่าง 0–100");
    else discountMinor = percentOf(input.fullMinor, input.value);
  } else if (input.kind === "BAHT") {
    if (!Number.isInteger(input.value) || input.value <= 0) problems.push("ส่วนลดเป็นบาทต้องเป็นจำนวนเต็มบวก");
    else discountMinor = input.value;
  } else {
    problems.push("ชนิดส่วนลดไม่ถูกต้อง");
  }

  // The amount checks run whenever the kind/value themselves parsed, independently of the reason — so a form
  // showing "no reason" and "more than the price" at once tells the user everything in one pass instead of one
  // refusal at a time.
  if (discountMinor > 0 || problems.length === 0) {
    // A discount that rounds to nothing is not a discount — posting a −0 movement would be noise in the books.
    if (discountMinor <= 0) problems.push("ส่วนลดต้องมากกว่า 0");
    // 🔴 Refuse, never clamp. This is the line that keeps a typo from becoming a zero-baht sale.
    else if (discountMinor > input.fullMinor) problems.push("ส่วนลดมากกว่าราคาเต็ม — ตรวจสอบตัวเลขอีกครั้ง");
  }

  return problems.length ? { ok: false, discountMinor: 0, problems } : { ok: true, discountMinor, problems: [] };
}

/** The movement a valid plan produces: negative value, `qty 0`, same item + refId as the sale it reduces. */
export const discountMovement = (input: {
  refId: string;
  discountMinor: number;
  actor: string | null;
  reason: string;
}) => ({
  qty: 0, // it moves money, not stock — a discount is not a second unit sold
  valueMinor: -input.discountMinor,
  reason: "DISCOUNT" as const,
  refType: "SALE" as const,
  refId: input.refId,
  actor: input.actor,
  note: input.reason.trim(),
  // One discount per sale, so a retried request can never post a second one.
  idempotencyKey: `discount:${input.refId}`,
});

/**
 * Validate a sale's optional discount **before anything is written**, and return what `recordSale` should post.
 *
 * The split matters: validation happens at the service boundary (so an invalid discount refuses the whole sale),
 * while the posting happens inside `recordSale` (whose first rule is that it can never fail a sale). Keeping the
 * two apart is what lets "refuse, never clamp" and "never break a booking" both be true.
 *
 * `listPriceMinor` is the LINE TOTAL of the sale being made — for a rental that is `hours × rate` (AC-14).
 */
export function validateSaleDiscount(
  discount: { kind: DiscountKind; value: number; reason: string } | undefined,
  listPriceMinor: number,
  actor: string | null,
): { discountMinor: number; reason: string; actor: string | null } | undefined {
  if (!discount) return undefined; // no discount asked for ⇒ the sale posts exactly as it always has (AC-7)
  const plan = planDiscount({ ...discount, fullMinor: listPriceMinor });
  if (!plan.ok) throw new DiscountRefused(plan.problems);
  return { discountMinor: plan.discountMinor, reason: discount.reason.trim(), actor };
}

/**
 * Thrown at the boundary so the sale is refused as a 400 carrying EVERY reason — never a partial write.
 *
 * It extends `ApiException` so the app's existing `onError` renders it without a special case; `details`
 * carries the full list, so the form can show all the problems at once instead of one per submit.
 */
export class DiscountRefused extends ApiException {
  constructor(public problems: string[]) {
    super(400, "DISCOUNT_REFUSED", problems.join(" · "), { problems });
  }
}

/**
 * Only an admin may discount (AC-9). Guarded **per request rather than per route**, on purpose: the sale routes
 * themselves are ordinary staff work, and putting `requireRole("admin")` on the whole route would stop a
 * receptionist selling an undiscounted course. So the restriction lands exactly on the privileged part.
 *
 * ⚠️ Caveat carried from SPEC-059 Q1: there is only ONE role in the system today, so in practice this asserts an
 * authenticated admin and cannot yet distinguish a non-admin staff member. It is correct as written and becomes
 * meaningful the moment a staff role exists — which is why it is written now rather than left as a TODO.
 */
export function assertMayDiscount(
  discount: unknown,
  user: { role?: string } | undefined | null,
): void {
  if (!discount) return;
  if (!user || user.role !== "admin") {
    throw new ApiException(403, "FORBIDDEN", "เฉพาะแอดมินเท่านั้นที่ให้ส่วนลดได้");
  }
}

/**
 * TASK-162 — re-validate a discount that was stored on a booking, at the moment it is finally POSTED.
 *
 * The gap between capture and posting is real: the catalogue price can change between booking a session and the
 * end-of-day job. A stored 10% is still 10%, but a stored ฿500 against a since-reduced price could exceed the
 * sale. So the same rule runs again — and if it no longer holds, the discount is **dropped with a loud log**
 * rather than posted. Dropping is right here (unlike at sale time, where we refuse): the session happened and
 * the customer owes something; posting the full price and shouting is recoverable, posting a negative larger
 * than the sale is not.
 */
export function safeStoredDiscount(
  stored: { kind: DiscountKind; value: number; reason: string },
  listPriceMinor: number,
  actor: string | null,
  bookingId: string,
): { discountMinor: number; reason: string; actor: string | null } | undefined {
  const plan = planDiscount({ ...stored, fullMinor: listPriceMinor });
  if (plan.ok) return { discountMinor: plan.discountMinor, reason: stored.reason.trim(), actor };
  console.error(
    `[discount] NOT POSTED for booking ${bookingId} — the discount stored at booking time is no longer valid ` +
      `against the current price (${plan.problems.join(" · ")}). The sale posted at FULL price; ` +
      `the discount needs a human decision.`,
  );
  return undefined;
}
