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
  rentalIdBase,
  rentalIdempotencyKey,
  rentalPriceList,
  voucherPriceList,
  listPriceMinor,
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

  test("rentalPriceList exposes code+priceMinor from the one authority (TASK-123) — no labels cross the wire", () => {
    const list = rentalPriceList();
    expect(list).toEqual([
      { code: "rental-set", priceMinor: THB(200) },
      { code: "rental-ride", priceMinor: THB(150) },
      { code: "rental-helmet", priceMinor: THB(50) },
      { code: "rental-pads", priceMinor: THB(50) },
    ]);
    // each price matches the seed item's price (single source — can't drift from what recordSale charges)
    for (const { code, priceMinor } of list) {
      expect(SALE_ITEMS.find((i) => i.externalRef === code)!.unitPriceMinor).toBe(priceMinor);
    }
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

  test("rentalIdBase — refId wins, else client key, else undefined (AC #4 standalone idempotency)", () => {
    expect(rentalIdBase("booking-1", "client-key")).toBe("booking-1"); // add-on: refId wins
    expect(rentalIdBase(undefined, "client-key")).toBe("client-key"); // standalone: client key makes it idempotent
    expect(rentalIdBase(null, "client-key")).toBe("client-key");
    expect(rentalIdBase(undefined, undefined)).toBeUndefined(); // → service mints a fresh id (its own sale)
    // two standalone posts with the SAME client key derive the SAME key → recordSale dedupes to one movement.
    const k = rentalIdBase(undefined, "abc")!;
    expect(rentalIdempotencyKey(k, "rental-set")).toBe(rentalIdempotencyKey(rentalIdBase(undefined, "abc")!, "rental-set"));
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

  // REQ-061 / TASK-158: the owner's card DOES carry an onewheel 10 h (11,900). This assertion — and the comment
  // it mirrored in `sale-items.ts` — were wrong about the product, not merely out of date. Both corrected.
  test("Onewheel 10 h EXISTS at 11,900 (REQ-061 correction)", () => {
    expect(isSellable("onewheel", 10)).toBe(true);
    expect(isKnownSaleItem(courseItemRef("onewheel", 10))).toBe(true);
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

  test("onewheel 1 / 4 / 6 / 10 h = 1,690 / 5,790 / 7,900 / 11,900 (REQ-061: 6 h corrected, 10 h added)", () => {
    expect(priceOf(sessionItemRef("onewheel"))).toBe(THB(1690));
    expect(priceOf(courseItemRef("onewheel", 4))).toBe(THB(5790));
    expect(priceOf(courseItemRef("onewheel", 6))).toBe(THB(7900)); // was 7,990 — the card says 7,900
    expect(priceOf(courseItemRef("onewheel", 10))).toBe(THB(11900));
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
  test("13 program items + 3 vouchers + first trial + 4 rentals", () => {
    // 3 single-session rows (onewheel · balance-private · balance-group — bike/skate has no 1h rate)
    // + 10 course rows (bike-skate 4/6/10 · onewheel 4/6/10 · balance-private 6/10 · balance-group 6/10) —
    // onewheel 10 h added by REQ-061.

    const sessions = sellablePackages().filter((p) => p.size === 1);
    const courses = sellablePackages().filter((p) => p.size !== 1);
    expect(sessions).toHaveLength(3);
    expect(courses).toHaveLength(10);
    // + TASK-108: the 4 equipment-rental codes.
    expect(SALE_ITEMS).toHaveLength(13 + VOUCHER_HOURS.length + 1 + RENTAL_ITEMS.length);
  });

  test("every course size the DB allows is priced for at least one group", () => {
    for (const size of COURSE_SIZES) {
      expect(PRICE_GROUPS.some((g) => isSellable(g, size))).toBe(true);
    }
  });
});

// ─────────────── SPEC-059 / TASK-164 — the last two prices the discount form needs ───────────────
//
// The point of these tests is NOT that the numbers are 6000/10500/13500 — it is that the number the FE shows
// as "ราคาเต็ม" and the number `recordSale` posts are **the same number**. A voucher price list that agreed
// with the card on the day it was written and drifted later is precisely the failure TASK-123 exists to
// prevent, and a discount computed off a stale full price is wrong money, not a wrong label.
describe("voucher + 1st-Trial price exposure (TASK-164)", () => {
  test("voucherPriceList covers exactly the three hour buckets, in order", () => {
    expect(voucherPriceList().map((v) => v.hours)).toEqual([...VOUCHER_HOURS]);
  });

  test("🔴 every exposed voucher price IS the price its own sale item posts", () => {
    for (const { hours, priceMinor } of voucherPriceList()) {
      expect(listPriceMinor(voucherItemRef(hours))).toBe(priceMinor);
    }
  });

  test("🔴 the exposed 1st-Trial price IS the price the `first-trial` item posts", () => {
    // `firstTrialPriceMinor` on the endpoint is this constant; if the seed ever stopped deriving from it,
    // the form would quote one price while the day-end sale posted another.
    expect(listPriceMinor("first-trial")).toBe(FIRST_TRIAL_MINOR);
  });

  test("prices are VAT-inclusive minor units, never zero", () => {
    // A zero would sail through the discount rule (any discount ≥ full price is refused) as "everything is
    // refused", which reads as a broken form rather than a missing price. Pin it here instead.
    for (const { priceMinor } of voucherPriceList()) expect(priceMinor).toBeGreaterThan(0);
    expect(FIRST_TRIAL_MINOR).toBeGreaterThan(0);
  });
});
