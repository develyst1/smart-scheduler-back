// TASK-066 — the product-code catalogue. Pure, no DB.
// The bug this guards against isn't arithmetic: it's a code existing with no item to post it to,
// which is exactly how course/voucher revenue went missing without anyone noticing.
import { describe, expect, test } from "bun:test";
import {
  COURSE_SIZES,
  PLACEHOLDER_HOURLY_MINOR,
  SALE_ITEMS,
  VOUCHER_HOURS,
  courseItemRef,
  isKnownSaleItem,
  revenueItemRef,
  voucherItemRef,
} from "./sale-items";

describe("every code a sale can produce has an item to post to", () => {
  test("🔑 course sizes — the codes scheduler.service actually emits", () => {
    // The service calls courseItemRef(input.size); size is checked in the DB by course_size_chk (4|6|10).
    for (const size of COURSE_SIZES) expect(isKnownSaleItem(courseItemRef(size))).toBe(true);
  });

  test("🔑 voucher hours — same, for the sizes lib/voucher.ts allows", () => {
    for (const hours of VOUCHER_HOURS) expect(isKnownSaleItem(voucherItemRef(hours))).toBe(true);
  });

  test("🔑 the two day-end codes", () => {
    expect(isKnownSaleItem(revenueItemRef("FIRST_TRIAL")!)).toBe(true);
    expect(isKnownSaleItem(revenueItemRef("SINGLE_SESSION")!)).toBe(true);
  });

  test("a code we don't sell is NOT silently accepted", () => {
    expect(isKnownSaleItem("course-8")).toBe(false); // the unconfirmed 8-week assumption is not a product
    expect(isKnownSaleItem("")).toBe(false);
  });

  test("no duplicate external_refs — the unique index would reject the second one", () => {
    const refs = SALE_ITEMS.map((i) => i.externalRef);
    expect(new Set(refs).size).toBe(refs.length);
  });

  test("eight items: 2 one-off + 3 course sizes + 3 voucher sizes", () => {
    expect(SALE_ITEMS.length).toBe(2 + COURSE_SIZES.length + VOUCHER_HOURS.length);
  });
});

describe("revenueItemRef — unchanged behaviour, just moved (TASK-007)", () => {
  test("maps only one-off trial/single; course/voucher recognise revenue at sale", () => {
    expect(revenueItemRef("FIRST_TRIAL")).toBe("first-trial");
    expect(revenueItemRef("SINGLE_SESSION")).toBe("single-session");
    expect(revenueItemRef("COURSE_PACKAGE")).toBeNull();
    expect(revenueItemRef("VOUCHER")).toBeNull();
  });
});

describe("placeholder prices are derived, not invented", () => {
  test("every price is the existing 1,390 THB/hr placeholder x the product's hours", () => {
    for (const i of SALE_ITEMS) expect(i.unitPriceMinor).toBe(PLACEHOLDER_HOURLY_MINOR * i.hours);
  });

  test("prices are whole satang and positive — a 0 price would post revenue as zero, silently", () => {
    for (const i of SALE_ITEMS) {
      expect(i.unitPriceMinor).toBeGreaterThan(0);
      expect(Number.isInteger(i.unitPriceMinor)).toBe(true);
    }
  });
});
