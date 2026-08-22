// TASK-160 / TASK-162 (SPEC-059 / REQ-063) — the discount rule. This is money taken off in front of a customer,
// so most of these tests are about what must be REFUSED: the one behaviour that matters is refuse-never-clamp.
import { describe, expect, test } from "bun:test";
import {
  bahtToMinor,
  DiscountRefused,
  assertMayDiscount,
  discountMovement,
  percentOf,
  planDiscount,
  safeStoredDiscount,
  validateSaleDiscount,
} from "./discount-plan";

const ok = (over: Partial<Parameters<typeof planDiscount>[0]> = {}) =>
  planDiscount({ kind: "PERCENT", value: 10, fullMinor: 790000, reason: "โปรวันแม่", ...over });

describe("valid discounts (AC-1/AC-2)", () => {
  test("10% of a 7,900 course = 790", () => {
    expect(ok()).toEqual({ ok: true, discountMinor: 79000, problems: [] });
  });

  test("🔴 a baht discount is WHOLE BAHT — 500 means ฿500 off, not ฿5 (TASK-168)", () => {
    // The defect Tanya found: staff type baht, the value travelled as satang, and ฿391 posted as ฿3.91 with
    // nothing to refuse it. This test is the contract, stated in the unit a person actually types.
    expect(ok({ kind: "BAHT", value: 500 }).discountMinor).toBe(50000);
    expect(ok({ kind: "BAHT", value: 391, fullMinor: 139000 }).discountMinor).toBe(39100);
    expect(bahtToMinor(391)).toBe(39100);
  });

  test("100% is allowed — a free place is a real decision, and it is recorded as one", () => {
    expect(ok({ value: 100 }).discountMinor).toBe(790000);
  });

  test("🔑 the rental trap (AC-14): the LINE TOTAL is what a baht discount is judged against", () => {
    // 3 hours × ฿200 = ฿600 line. ฿500 off is valid…
    expect(ok({ kind: "BAHT", value: 500, fullMinor: 60000 }).ok).toBe(true);
    // …and would have been wrongly refused against the ฿200 unit rate.
    expect(ok({ kind: "BAHT", value: 500, fullMinor: 20000 }).ok).toBe(false);
  });

  test("rounding is half-up on minor units, stated so it cannot drift", () => {
    expect(percentOf(790500, 10)).toBe(79050);
    expect(percentOf(1, 50)).toBe(1); // 0.5 → 1
  });
});

describe("🔴 refuse, never clamp (AC-4)", () => {
  test("more baht than the price is REFUSED — not capped at the price", () => {
    const r = ok({ kind: "BAHT", value: 9000 });
    expect(r.ok).toBe(false);
    expect(r.discountMinor).toBe(0); // nothing to write, so nothing gets written
    expect(r.problems.join()).toContain("มากกว่าราคาเต็ม");
  });

  test("over 100% is refused", () => {
    expect(ok({ value: 120 }).ok).toBe(false);
  });

  test("zero and negative are refused, both kinds", () => {
    for (const v of [0, -5]) {
      expect(ok({ value: v }).ok).toBe(false);
      expect(ok({ kind: "BAHT", value: v }).ok).toBe(false);
    }
  });

  test("a discount that rounds to nothing is refused rather than posting a −0 movement", () => {
    expect(ok({ fullMinor: 1, value: 0.4 }).ok).toBe(false);
  });

  test("AC-3: no reason ⇒ refused — an unexplained discount is unauditable", () => {
    expect(ok({ reason: "" }).ok).toBe(false);
    expect(ok({ reason: "   " }).problems.join()).toContain("เหตุผล");
  });

  test("a malformed kind or a nonsense number is refused, not coerced", () => {
    expect(planDiscount({ kind: "OTHER" as any, value: 10, fullMinor: 790000, reason: "x" }).ok).toBe(false);
    expect(ok({ value: NaN }).ok).toBe(false);
    expect(ok({ fullMinor: 0 }).ok).toBe(false);
  });

  test("a fractional baht value is refused — satang are integers", () => {
    expect(ok({ kind: "BAHT", value: 1234.5 }).ok).toBe(false);
  });

  test("every refusal reports WHY, so the form can say it rather than just failing", () => {
    const r = ok({ kind: "BAHT", value: 9000, reason: "" });
    expect(r.problems).toHaveLength(2);
  });
});

describe("the movement a valid plan produces", () => {
  const m = discountMovement({ refId: "course-1", discountMinor: 79000, actor: "u-1", reason: " โปรวันแม่ " });

  test("negative value, qty 0, the sale's own refId — so it nets its own sport", () => {
    expect(m).toMatchObject({ qty: 0, valueMinor: -79000, reason: "DISCOUNT", refType: "SALE", refId: "course-1" });
  });

  test("carries who and why (AC-10), trimmed", () => {
    expect(m.actor).toBe("u-1");
    expect(m.note).toBe("โปรวันแม่");
  });

  test("🔑 idempotency key is per sale — a retried request cannot post a second discount", () => {
    expect(m.idempotencyKey).toBe("discount:course-1");
    expect(discountMovement({ refId: "course-1", discountMinor: 1, actor: null, reason: "x" }).idempotencyKey).toBe(
      m.idempotencyKey,
    );
  });
});

// ── The boundary validator (TASK-160) ───────────────────────────────────────────────────────────────────────
// This is the half that decides whether a SALE happens at all, so what it must do is throw *before* any write —
// never return a clamped amount for the caller to post.
describe("validateSaleDiscount", () => {
  test("no discount asked for ⇒ undefined, and the sale posts exactly as it always has (AC-7)", () => {
    expect(validateSaleDiscount(undefined, 790000, "u-1")).toBeUndefined();
  });

  test("a valid discount comes back ready to post, with who and why", () => {
    expect(validateSaleDiscount({ kind: "PERCENT", value: 10, reason: " โปรวันแม่ " }, 790000, "u-1")).toEqual({
      discountMinor: 79000,
      reason: "โปรวันแม่",
      actor: "u-1",
    });
  });

  test("🔴 an invalid discount THROWS — the caller gets no amount to write", () => {
    expect(() => validateSaleDiscount({ kind: "BAHT", value: 9000, reason: "x" }, 790000, null)).toThrow(
      DiscountRefused,
    );
  });

  test("the refusal carries every problem, so the form can show them at once", () => {
    try {
      validateSaleDiscount({ kind: "BAHT", value: 9000, reason: "" }, 790000, null);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DiscountRefused);
      expect((e as DiscountRefused).problems).toHaveLength(2);
    }
  });

  test("🔑 AC-14 end to end: a rental's LINE TOTAL is what gets validated", () => {
    const threeHoursOfSixHundred = 200_00 * 3; // 3h × ฿200 = ฿600 (a LINE TOTAL, so still minor units)
    expect(validateSaleDiscount({ kind: "BAHT", value: 500, reason: "โปร" }, threeHoursOfSixHundred, null)).toEqual({
      discountMinor: 50000,
      reason: "โปร",
      actor: null,
    });
    // the same discount judged against ONE hour would refuse — which is the bug this parameter prevents
    expect(() => validateSaleDiscount({ kind: "BAHT", value: 500, reason: "โปร" }, 200_00, null)).toThrow();
  });

  test("an unknown product code (list price 0) refuses rather than discounting an unpriced sale", () => {
    expect(() => validateSaleDiscount({ kind: "PERCENT", value: 10, reason: "x" }, 0, null)).toThrow(DiscountRefused);
  });
});

// ── The admin guard (AC-9, TASK-160) ────────────────────────────────────────────────────────────────────────
describe("assertMayDiscount", () => {
  test("no discount ⇒ anyone may sell — an ordinary sale is not privileged work", () => {
    expect(() => assertMayDiscount(undefined, undefined)).not.toThrow();
    expect(() => assertMayDiscount(undefined, { role: "staff" })).not.toThrow();
  });

  test("an admin may discount", () => {
    expect(() => assertMayDiscount({ kind: "BAHT", value: 100 }, { role: "admin" })).not.toThrow();
  });

  test("🔴 a non-admin (or an unauthenticated caller) may NOT", () => {
    expect(() => assertMayDiscount({ kind: "BAHT", value: 100 }, { role: "staff" })).toThrow(/แอดมิน/);
    expect(() => assertMayDiscount({ kind: "BAHT", value: 100 }, undefined)).toThrow();
  });

  test("the refusal is a 403, so it can't be confused with a validation problem", () => {
    try {
      assertMayDiscount({ kind: "BAHT", value: 100 }, { role: "staff" });
    } catch (e: any) {
      expect(e.status).toBe(403);
      expect(e.code).toBe("FORBIDDEN");
    }
  });
});

describe("DiscountRefused is a 400 the app already knows how to render", () => {
  test("status/code/details carry every problem to the form", () => {
    const e = new DiscountRefused(["a", "b"]);
    expect(e.status).toBe(400);
    expect(e.code).toBe("DISCOUNT_REFUSED");
    expect(e.details).toEqual({ problems: ["a", "b"] });
  });
});

// ── Day-end re-validation (TASK-162) ────────────────────────────────────────────────────────────────────────
// A discount is authorised when the session is BOOKED and posted at day-end. The price can move in between, so
// the stored amount is checked again at posting — and if it no longer holds, it is DROPPED loudly rather than
// posted. Dropping is right here: the session happened and the customer owes something, so posting full price
// and shouting is recoverable; posting a negative bigger than the sale is not.
describe("safeStoredDiscount", () => {
  const stored = { kind: "PERCENT" as const, value: 10, reason: "โปรวันแม่" };

  test("a still-valid stored discount posts, carrying its captured author", () => {
    expect(safeStoredDiscount(stored, 139000, "u-admin", "b-1")).toEqual({
      discountMinor: 13900,
      reason: "โปรวันแม่",
      actor: "u-admin",
    });
  });

  test("🔑 a percentage survives a price change — it re-computes against the NEW price", () => {
    expect(safeStoredDiscount(stored, 100000, null, "b-1")?.discountMinor).toBe(10000);
  });

  test("🔴 a stored BAHT amount is re-read as BAHT at day-end — the two moments share one contract (TASK-168)", () => {
    // The ripple that would have made the fix half-land: capture stores what was typed, and the day-end runs the
    // SAME `planDiscount` — so ฿500 stored is ฿500 posted, hours later, with no second conversion anywhere.
    expect(safeStoredDiscount({ kind: "BAHT", value: 500, reason: "x" }, 139000, null, "b-1")?.discountMinor).toBe(
      50000,
    );
  });

  test("🔴 a stored BAHT amount that now exceeds the price is DROPPED, not posted", () => {
    expect(safeStoredDiscount({ kind: "BAHT", value: 1500, reason: "x" }, 139000, null, "b-1")).toBeUndefined();
  });

  test("a booking whose program lost its price (list 0) drops the discount rather than dividing by nothing", () => {
    expect(safeStoredDiscount(stored, 0, null, "b-1")).toBeUndefined();
  });

  test("a corrupt stored row (no reason) is dropped — it could never be justified in the books", () => {
    expect(safeStoredDiscount({ ...stored, reason: "" }, 139000, null, "b-1")).toBeUndefined();
  });
});
