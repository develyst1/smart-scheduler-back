// TASK-066 + TASK-077 — the product catalogue. Pure, no DB.
//
// Two bugs this guards against:
//   1. a code existing with no item to post to (how course/voucher revenue went missing entirely), and
//   2. a (program, size) that isn't on the owner's card being sellable anyway — which posts a price she
//      doesn't charge.
import { describe, expect, test } from "bun:test";
import {
  COURSE_SIZES,
  FIRST_TRIAL_MINOR,
  PRICES_ARE_VAT_INCLUSIVE,
  PRICE_GROUPS,
  SALE_ITEMS,
  VOUCHER_HOURS,
  courseItemRef,
  isKnownSaleItem,
  isSellable,
  RENTAL_CODES,
  RENTAL_ITEMS,
  isRentalCode,
  rentalIdempotencyKey,
  revenueItemRef,
  sellablePackages,
  sessionItemRef,
  voucherAllowedGroups,
  voucherAllowsProgram,
  voucherItemRef,
} from "./sale-items";
import { saleMovement } from "./sale-post";

const THB = (baht: number) => baht * 100;

describe("voucher program exclusion (SPEC-030 / TASK-106)", () => {
  test("Onewheel + both Balance Play are excluded; bike/skate is allowed", () => {
    expect(voucherAllowsProgram("bike-skate")).toBe(true);
    for (const g of ["onewheel", "balance-private", "balance-group"]) {
      expect(voucherAllowsProgram(g)).toBe(false);
    }
  });

  test("null/empty group is NOT allowed — 1st Trial (no price group) goes through the same null-group path", () => {
    // `resolvePriceGroup` returns a real PriceGroup or null; a null/absent group is refused (no special case).
    expect(voucherAllowsProgram(null)).toBe(false);
    expect(voucherAllowsProgram(undefined)).toBe(false);
    expect(voucherAllowsProgram("")).toBe(false);
  });

  test("voucherAllowedGroups is derived from PRICE_GROUPS (never a hardcoded FE list)", () => {
    expect(voucherAllowedGroups()).toEqual(["bike-skate"]);
    // every allowed group is a real price group, and none is an excluded one
    for (const g of voucherAllowedGroups()) {
      expect(PRICE_GROUPS).toContain(g);
      expect(voucherAllowsProgram(g)).toBe(true);
    }
  });
});

describe("equipment rental as revenue (SPEC-031 / TASK-108)", () => {
  const EXPECTED = { "rental-set": 200, "rental-ride": 150, "rental-helmet": 50, "rental-pads": 50 } as const;

  test("the four codes are known sale items at the VAT-inclusive card price", () => {
    expect([...RENTAL_CODES]).toEqual(["rental-set", "rental-ride", "rental-helmet", "rental-pads"]);
    for (const code of RENTAL_CODES) {
      expect(isKnownSaleItem(code)).toBe(true); // recordSale won't refuse it
      const item = SALE_ITEMS.find((i) => i.externalRef === code)!;
      expect(item.unitPriceMinor).toBe(THB(EXPECTED[code]));
      expect(item.metadata).toEqual({ revenueKind: "RENTAL" }); // separates rental from tuition in reports (AC #3)
    }
  });

  test("hours × price posts the right signed movement (a sale is OUT, positive value)", () => {
    const set = SALE_ITEMS.find((i) => i.externalRef === "rental-set")!;
    // 3h of a 200/hr full set = 600 THB income
    expect(saleMovement(3, set.unitPriceMinor)).toEqual({ qty: -3, valueMinor: THB(600) });
  });

  test("isRentalCode guards the endpoint's code param", () => {
    expect(isRentalCode("rental-set")).toBe(true);
    expect(isRentalCode("course-6")).toBe(false);
    expect(isRentalCode("rental-unknown")).toBe(false);
  });

  test("RENTAL_ITEMS all carry the RENTAL marker; idempotency key is stable per (base, code)", () => {
    expect(RENTAL_ITEMS).toHaveLength(4);
    expect(RENTAL_ITEMS.every((i) => (i.metadata as any)?.revenueKind === "RENTAL")).toBe(true);
    expect(rentalIdempotencyKey("booking-123", "rental-set")).toBe("rental:booking-123:rental-set");
  });
});

describe("🔑 the catalogue IS the availability rule — no second list to drift", () => {
  test("every sellable combination has an item, and every item has a price", () => {
    for (const p of sellablePackages()) {
      expect(isKnownSaleItem(p.externalRef)).toBe(true);
      expect(p.priceMinor).toBeGreaterThan(0);
    }
    for (const i of SALE_ITEMS) expect(i.unitPriceMinor).toBeGreaterThan(0);
  });

  test("🔴 Onewheel has NO 10-hour package — no item, so the sale refuses loudly", () => {
    expect(isSellable("onewheel", 10)).toBe(false);
    expect(isKnownSaleItem(courseItemRef("onewheel", 10))).toBe(false);
  });

  test("🔴 Balance Play (either) has NO 4-hour package", () => {
    for (const g of ["balance-private", "balance-group"]) {
      expect(isSellable(g, 4)).toBe(false);
      expect(isKnownSaleItem(courseItemRef(g, 4))).toBe(false);
    }
  });

  test("🔴 bike/skate has NO single-hour rate — the card simply has no 1h row for it", () => {
    // Flagged to Sober: a SINGLE_SESSION on a skate program therefore has no price and refuses.
    expect(isSellable("bike-skate", 1)).toBe(false);
    expect(isKnownSaleItem(sessionItemRef("bike-skate"))).toBe(false);
  });

  test("a subject with NO price group can never be sold — it must not fall back to a default", () => {
    expect(isSellable(null, 6)).toBe(false);
    expect(isSellable(undefined, 6)).toBe(false);
    expect(isSellable("", 6)).toBe(false);
  });

  test("no duplicate external_refs — the unique index would reject the second", () => {
    const refs = SALE_ITEMS.map((i) => i.externalRef);
    expect(new Set(refs).size).toBe(refs.length);
  });
});

describe("the card, transcribed — every figure from the owner's price list", () => {
  const priceOf = (ref: string) => SALE_ITEMS.find((i) => i.externalRef === ref)?.unitPriceMinor;

  test("bike-skate 4 / 6 / 10 h = 4,790 / 6,490 / 9,790", () => {
    expect(priceOf(courseItemRef("bike-skate", 4))).toBe(THB(4790));
    expect(priceOf(courseItemRef("bike-skate", 6))).toBe(THB(6490));
    expect(priceOf(courseItemRef("bike-skate", 10))).toBe(THB(9790));
  });

  test("onewheel 1 / 4 / 6 h = 1,690 / 5,790 / 7,990", () => {
    expect(priceOf(sessionItemRef("onewheel"))).toBe(THB(1690));
    expect(priceOf(courseItemRef("onewheel", 4))).toBe(THB(5790));
    expect(priceOf(courseItemRef("onewheel", 6))).toBe(THB(7990));
  });

  test("balance-private 1 / 6 / 10 h = 1,390 / 7,490 / 11,390", () => {
    expect(priceOf(sessionItemRef("balance-private"))).toBe(THB(1390));
    expect(priceOf(courseItemRef("balance-private", 6))).toBe(THB(7490));
    expect(priceOf(courseItemRef("balance-private", 10))).toBe(THB(11390));
  });

  test("balance-group 1 / 6 / 10 h = 1,090 / 5,290 / 7,790", () => {
    expect(priceOf(sessionItemRef("balance-group"))).toBe(THB(1090));
    expect(priceOf(courseItemRef("balance-group", 6))).toBe(THB(5290));
    expect(priceOf(courseItemRef("balance-group", 10))).toBe(THB(7790));
  });

  test("vouchers 5 / 10 / 15 h = 6,000 / 10,500 / 13,500; first trial 1,390", () => {
    expect(priceOf(voucherItemRef(5))).toBe(THB(6000));
    expect(priceOf(voucherItemRef(10))).toBe(THB(10500));
    expect(priceOf(voucherItemRef(15))).toBe(THB(13500));
    expect(FIRST_TRIAL_MINOR).toBe(THB(1390));
  });

  test("🔴 prices are VAT-INCLUSIVE — never add tax on top", () => {
    expect(PRICES_ARE_VAT_INCLUSIVE).toBe(true);
  });

  test("the per-hour rate FALLS with package size — which a flat hourly rate cannot express", () => {
    // This is why TASK-066's placeholder (hours × a flat rate) was structurally wrong, not just imprecise.
    const perHour = (ref: string, hours: number) => priceOf(ref)! / hours;
    expect(perHour(courseItemRef("bike-skate", 10), 10)).toBeLessThan(
      perHour(courseItemRef("bike-skate", 4), 4),
    );
  });
});

describe("revenueItemRef — the day-end path is now program-priced too", () => {
  test("first trial is one price for everyone, unchanged", () => {
    expect(revenueItemRef("FIRST_TRIAL")).toBe("first-trial");
    expect(isKnownSaleItem("first-trial")).toBe(true);
  });

  test("🔑 a single session posts against its PROGRAM's hourly rate, not a flat one", () => {
    expect(revenueItemRef("SINGLE_SESSION", "onewheel")).toBe(sessionItemRef("onewheel"));
    expect(revenueItemRef("SINGLE_SESSION", "balance-group")).toBe(sessionItemRef("balance-group"));
  });

  test("🔴 no price group → null, so the caller refuses instead of inventing a price", () => {
    expect(revenueItemRef("SINGLE_SESSION", null)).toBeNull();
    expect(revenueItemRef("SINGLE_SESSION")).toBeNull();
  });

  test("course/voucher recognise revenue at sale, so they don't re-post at day-end", () => {
    expect(revenueItemRef("COURSE_PACKAGE", "onewheel")).toBeNull();
    expect(revenueItemRef("VOUCHER", "onewheel")).toBeNull();
  });
});

describe("shape", () => {
  test("12 program items + 3 vouchers + first trial + 4 rentals", () => {
    // 3 single-session rows (onewheel · balance-private · balance-group — bike/skate has no 1h rate)
    // + 9 course rows (bike-skate 4/6/10 · onewheel 4/6 · balance-private 6/10 · balance-group 6/10).
    const sessions = sellablePackages().filter((p) => p.size === 1);
    const courses = sellablePackages().filter((p) => p.size !== 1);
    expect(sessions).toHaveLength(3);
    expect(courses).toHaveLength(9);
    // + TASK-108: the 4 equipment-rental codes.
    expect(SALE_ITEMS).toHaveLength(12 + VOUCHER_HOURS.length + 1 + RENTAL_ITEMS.length);
  });

  test("every course size the DB allows is priced for at least one group", () => {
    for (const size of COURSE_SIZES) {
      expect(PRICE_GROUPS.some((g) => isSellable(g, size))).toBe(true);
    }
  });
});
