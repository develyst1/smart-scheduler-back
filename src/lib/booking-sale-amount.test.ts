import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  courseLine,
  courseSaleKeys,
  netSaleMinor,
  parkFeeLine,
  rentalLine,
  trialOrSingleLine,
  voucherLine,
  type ConfirmedBookingFacts,
} from "./booking-sale-amount";
import { PRICE_GROUPS, listPriceMinor, revenueItemRef, voucherItemRef } from "./sale-items";

// TASK-864 — the amount of each kind and the revenue line it becomes. DB-free. Expected prices come from the SAME
// helpers the day-end uses (`listPriceMinor` …), never from a number copied here, so a catalogue change moves both.
const GROUP = PRICE_GROUPS[0] as string;
let errors: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  errors = [];
  spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
});
afterEach(() => spy.mockRestore());

const booking = (over: Partial<ConfirmedBookingFacts> = {}): ConfirmedBookingFacts => ({
  id: "b-1",
  bookingType: "FIRST_TRIAL",
  subjectName: "Inline Skate",
  who: "Nong A",
  ...over,
});

describe("trial", () => {
  test("FIRST_TRIAL → TRIAL · '1st Trial (<subject>)', key rl:booking:<id>, the list price", () => {
    const l = trialOrSingleLine(booking(), null)!;
    expect(l.idempotencyKey).toBe("rl:booking:b-1");
    expect(l.type).toBe("TRIAL");
    expect(l.categoryName).toBe("1st Trial (Inline Skate)");
    expect(l.productName).toBe("Inline Skate Trial — Nong A");
    expect(l.amountMinor).toBe(listPriceMinor("first-trial")!);
    expect([l.source, l.refType, l.refId]).toEqual(["BOOKING", "BOOKING", "b-1"]);
  });
  test("a stored PERCENT discount nets off the list price, as the day-end does", () => {
    const list = listPriceMinor("first-trial")!;
    const l = trialOrSingleLine(booking({ discountKind: "PERCENT", discountValue: 10, discountReason: "promo" }), null)!;
    expect(l.amountMinor).toBe(list - Math.round(list / 10));
    expect(l.amountMinor).toBeLessThan(list);
  });
  test("a stored BAHT discount larger than the price is dropped loudly and the sale is at FULL price", () => {
    const list = listPriceMinor("first-trial")!;
    const l = trialOrSingleLine(booking({ discountKind: "BAHT", discountValue: list, discountReason: "x" }), null)!;
    expect(l.amountMinor).toBe(list);
    expect(errors.join("\n")).toContain("[discount] NOT POSTED for booking b-1");
  });
});

describe("1 HR (single session)", () => {
  test("SINGLE_SESSION → COURSE · '<subject> · 1 HR', priced by the program's group", () => {
    const l = trialOrSingleLine(booking({ id: "b-2", bookingType: "SINGLE_SESSION" }), GROUP)!;
    expect(l.type).toBe("COURSE");
    expect(l.categoryName).toBe("Inline Skate · 1 HR");
    expect(l.productName).toBe("Inline Skate 1 HR — Nong A");
    expect(l.idempotencyKey).toBe("rl:booking:b-2");
    expect(l.amountMinor).toBe(listPriceMinor(revenueItemRef("SINGLE_SESSION", GROUP)!)!);
  });
  test("no price group ⇒ no line, and it says why (never a default price)", () => {
    expect(trialOrSingleLine(booking({ bookingType: "SINGLE_SESSION" }), null)).toBeNull();
    expect(errors.join("\n")).toContain("rl:booking:b-1");
    expect(errors.join("\n")).toContain("NOT WRITTEN");
  });
  test("any other booking type is refused by the mapper itself", () => {
    expect(trialOrSingleLine(booking({ bookingType: "VOUCHER" }), GROUP)).toBeNull();
    expect(errors.length).toBe(1);
  });
  test("a booking with no subject name has no category ⇒ no line, loudly", () => {
    expect(trialOrSingleLine(booking({ subjectName: null }), null)).toBeNull();
    expect(errors.join("\n")).toContain("no subject");
  });
});

describe("course (first confirm)", () => {
  test("the NET posted sale = sale movement + the (negative) discount movement", () => {
    expect(netSaleMinor([{ valueMinor: 1420000 }, { valueMinor: -142000 }])).toBe(1278000);
    expect(netSaleMinor([])).toBe(0);
  });
  test("the keys it is read under are the ones createCoursePackage writes", () => {
    expect(courseSaleKeys("c-1")).toEqual(["course-sale:c-1", "discount:c-1"]);
  });
  test("a Private course → COURSE · '<subject> · Private', key rl:course:<id>", () => {
    const l = courseLine({ id: "c-1", subjectName: "Surfskate", duo: false, who: "Nong A" }, 1278000)!;
    expect(l.idempotencyKey).toBe("rl:course:c-1");
    expect([l.type, l.categoryName, l.productName]).toEqual(["COURSE", "Surfskate · Private", "Surfskate Private — Nong A"]);
    expect(l.amountMinor).toBe(1278000);
    expect([l.refType, l.refId]).toEqual(["COURSE", "c-1"]);
  });
  test("a course with a co-student is Duo, and the name carries 'A & B'", () => {
    const l = courseLine({ id: "c-2", subjectName: "Surfskate", duo: true, who: "A & B" }, 100)!;
    expect(l.categoryName).toBe("Surfskate · Duo");
    expect(l.productName).toBe("Surfskate Duo — A & B");
  });
  test("no posted sale movement ⇒ no line, loudly, naming the keys it looked for", () => {
    expect(courseLine({ id: "c-3", subjectName: "Surfskate", duo: false, who: null }, null)).toBeNull();
    expect(errors.join("\n")).toContain("course-sale:c-3");
  });
  test("a net of 0 or less (a fully discounted course) writes nothing", () => {
    expect(courseLine({ id: "c-4", subjectName: "Surfskate", duo: false, who: null }, 0)).toBeNull();
    expect(courseLine({ id: "c-4", subjectName: "Surfskate", duo: false, who: null }, -5)).toBeNull();
  });
});

describe("park fee (OTHER with the system teacher)", () => {
  test("a typed amount → RENT · PARK, key rl:booking:<id>", () => {
    const l = parkFeeLine({ id: "p-1", otherPriceMinor: 5000, otherPriceItemId: null }, null)!;
    expect([l.type, l.categoryName, l.productName, l.amountMinor]).toEqual(["RENT", "PARK", "Park fee", 5000]);
    expect(l.idempotencyKey).toBe("rl:booking:p-1");
  });
  test("a catalogue item's price is READ NOW and wins over the typed amount", () => {
    const l = parkFeeLine({ id: "p-2", otherPriceMinor: 5000, otherPriceItemId: "i-1" }, { active: true, unitPriceMinor: 7000 })!;
    expect(l.amountMinor).toBe(7000);
  });
  test("an inactive or missing item ⇒ no line, no invented fallback", () => {
    expect(parkFeeLine({ id: "p-3", otherPriceMinor: 5000, otherPriceItemId: "i-1" }, { active: false, unitPriceMinor: 7000 })).toBeNull();
    expect(parkFeeLine({ id: "p-3", otherPriceMinor: 5000, otherPriceItemId: "i-1" }, null)).toBeNull();
    expect(errors.length).toBe(2);
  });
  test("an uncharged booking writes nothing", () => {
    expect(parkFeeLine({ id: "p-4", otherPriceMinor: null, otherPriceItemId: null }, null)).toBeNull();
    expect(parkFeeLine({ id: "p-4", otherPriceMinor: 0, otherPriceItemId: null }, null)).toBeNull();
  });
});

describe("voucher", () => {
  test.each([5, 10, 15])("a %i-hour voucher → VOUCHER · '<hours> Hr' at its list price", (hours) => {
    const l = voucherLine({ id: "v-1", hours, who: "Nong A" }, 0)!;
    expect([l.type, l.categoryName, l.productName]).toEqual(["VOUCHER", `${hours} Hr`, `Voucher ${hours} Hr — Nong A`]);
    expect(l.amountMinor).toBe(listPriceMinor(voucherItemRef(hours))!);
    expect([l.idempotencyKey, l.refType, l.refId]).toEqual(["rl:voucher:v-1", "VOUCHER", "v-1"]);
  });
  test("the already-validated discount is netted off", () => {
    const list = listPriceMinor(voucherItemRef(10))!;
    expect(voucherLine({ id: "v-2", hours: 10, who: null }, 50000)!.amountMinor).toBe(list - 50000);
  });
  test("a voucher of an unpriced size ⇒ no line, loudly", () => {
    expect(voucherLine({ id: "v-3", hours: 7, who: null }, 0)).toBeNull();
    expect(errors.join("\n")).toContain("rl:voucher:v-3");
  });
});

describe("rental (every recordRental post)", () => {
  const press = { movementKey: "rental:b-9:rental-set", refId: "b-9", code: "rental-set", hours: 1 };
  test("the paid press (hours 1, no discount) → RENT · EQUIPMENT at the code's list price, key = rl: + the movement's key, source RENT", () => {
    const l = rentalLine(press)!;
    expect([l.type, l.categoryName, l.productName, l.source]).toEqual(["RENT", "EQUIPMENT", "Equipment rent", "RENT"]);
    expect(l.amountMinor).toBe(listPriceMinor("rental-set")!);
    expect([l.idempotencyKey, l.refType, l.refId]).toEqual(["rl:rental:b-9:rental-set", "RENTAL", "b-9"]);
  });
  test("a course's paid-upfront rental is list × size, under the course id", () => {
    const l = rentalLine({ movementKey: "rental:c-1:rental-set", refId: "c-1", code: "rental-set", hours: 10 })!;
    expect(l.amountMinor).toBe(listPriceMinor("rental-set")! * 10);
    expect(l.idempotencyKey).toBe("rl:rental:c-1:rental-set");
  });
  test("a standalone rental nets list × hours less its discount", () => {
    const rate = listPriceMinor("rental-set")!;
    expect(rentalLine({ ...press, hours: 3 }, 1000)!.amountMinor).toBe(rate * 3 - 1000);
  });
  test("two codes on one id are two lines (the key carries the code)", () => {
    const a = rentalLine({ ...press, movementKey: "rental:x:rental-set", code: "rental-set" })!;
    const b = rentalLine({ ...press, movementKey: "rental:x:rental-helmet", code: "rental-helmet" })!;
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
  test("an unknown code ⇒ no line, loudly, naming the key", () => {
    expect(rentalLine({ ...press, code: "rental-nope" })).toBeNull();
    expect(errors.join("\n")).toContain("rl:rental:b-9:rental-set");
  });
});
