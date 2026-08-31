// SPEC-070 / TASK-225 (REQ-078 AC-4/AC-5/AC-6) — charging an อื่นๆ booking.
//
// The movement itself needs a database, so it is deploy smoke exactly as `recordSale`'s insert has always been.
// What CAN be wrong in code, and is pinned here:
//   · the **sign** (invisible until a month-end number does not add up),
//   · **AC-4** — an uncharged booking must write nothing *at all*, not a ฿0 row,
//   · **which catalogue** the picker offers (offering the frontoffice product codes would post course revenue
//     with no course behind it),
//   · that the four existing types' posting path is byte-identical.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { OTHER_BOOKING_REF, SALE_ITEMS, isKnownSaleItem, listPriceMinor } from "../lib/sale-items";

const JOBS = readSrc(await Bun.file(new URL("./jobs.service.ts", import.meta.url)).text());
const POST = readSrc(await Bun.file(new URL("../lib/sale-post.ts", import.meta.url)).text());
const SVC = readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text());
const API = readSrc(await Bun.file(new URL("../routes/api.ts", import.meta.url)).text());

const fn = (src: string, decl: string) => {
  const at = src.indexOf(decl);
  const rest = src.slice(at);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};
const POST_BOOKING_SALE = fn(POST, "export async function postBookingSale");
const POST_OTHER = fn(JOBS, "async function postOtherBookingSale");
/** Comments stripped — for the assertions that are about ORDER or ABSENCE, where prose would answer for code. */
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const CODE_OTHER = code(POST_OTHER);
const CODE_POST_BOOKING_SALE = code(POST_BOOKING_SALE);

describe("🔴 the sign — a flipped one is invisible until month end", () => {
  test("the movement is an OUT (`qty: -1`) worth a POSITIVE `value_minor`", () => {
    // Must match `saleMovement` and backoffice `bo-money.ts:17`, or `SUM(value_minor)` nets the wrong way and
    // an อื่นๆ sale would subtract from the month instead of adding to it.
    expect(POST_BOOKING_SALE).toContain("qty: -1");
    expect(POST_BOOKING_SALE).toContain("valueMinor: opts.amountMinor");
    expect(POST_BOOKING_SALE).not.toContain("valueMinor: -opts.amountMinor");
  });

  test("a non-positive or non-integer amount posts NOTHING and says so", () => {
    // Reaching here with 0 is an upstream bug (AC-4 is handled before the call), and it must not become a row.
    expect(POST_BOOKING_SALE).toContain("!Number.isInteger(opts.amountMinor) || opts.amountMinor <= 0");
    expect(POST_BOOKING_SALE).toContain("NOT POSTED");
  });

  test("the amount is the CALLER's, never the item's own price", () => {
    // The whole reason this is a sibling of `recordSale` rather than a flag on it.
    expect(POST_BOOKING_SALE).not.toContain("item.unitPriceMinor");
  });
});

describe("🔴 AC-4 — not charged means NO movement, not a ฿0 one", () => {
  test("the uncharged case returns before anything is read or written", () => {
    // "Free" and "sold for nothing" are different claims. A zero row reads in the ledger as a sale that
    // happened, and then a report has to explain it.
    expect(POST_OTHER).toContain("if (b.otherPriceMinor == null && b.otherPriceItemId == null) return false;");
    const beforeGuard = POST_OTHER.slice(0, POST_OTHER.indexOf("otherPriceMinor == null"));
    for (const io of ["postBookingSale", "findFirst"]) expect(beforeGuard).not.toContain(io);
  });

  test("nothing in the อื่นๆ path can post a zero", () => {
    expect(POST_OTHER).not.toMatch(/amountMinor:\s*0/);
  });
});

describe("AC-5 / AC-6 — where the money lands, and what it is attributed to", () => {
  test("🔴 a CATALOGUE charge posts on THAT item's id, so a report can break it down", () => {
    expect(POST_OTHER).toContain("itemId: item.id");
    expect(POST_OTHER).toContain("amountMinor: item.unitPriceMinor");
  });

  test("the catalogue price is read at POSTING time, not captured at booking time", () => {
    // Same rule the stored discount already follows (`jobs.service.ts` re-validates against the price of the
    // day): the posted number must be the one that is true when it posts.
    //
    // ⚠️ Comments are stripped first. This function's prose names `postBookingSale` while explaining itself,
    // and an ordering assertion that reads prose measures the explanation, not the code.
    expect(POST_OTHER).toContain("db.query.boItem.findFirst");
    expect(CODE_OTHER.indexOf("findFirst")).toBeLessThan(CODE_OTHER.indexOf("postBookingSale"));
  });

  test("🔴 a missing or INACTIVE chosen item posts nothing and logs loudly — no fallback price", () => {
    // TASK-066's lesson: an invented number in the books is worse than a missing one, because nobody goes
    // looking for it.
    expect(POST_OTHER).toContain("if (!item || !item.active)");
    expect(POST_OTHER).toContain("no fallback price was invented");
    expect(POST_BOOKING_SALE).toContain("if (!item || !item.active)");
  });

  test("a TYPED amount posts to the `other-booking` bucket, with the typed amount", () => {
    expect(POST_OTHER).toContain("OTHER_BOOKING_REF");
    expect(POST_OTHER).toContain("amountMinor: b.otherPriceMinor!");
  });

  test("an unseeded bucket is the TASK-066 failure, and it is named as such", () => {
    expect(POST_OTHER).toContain("sale:ensure-items");
    expect(POST_OTHER).toContain("NOT POSTED");
  });

  test("🔴 a catalogue read that throws must NEVER fail the day-end job", () => {
    // This file's first rule. `postBookingSale` honours it for its own writes, but the item LOOKUPS are this
    // function's — an unreachable `bo` schema would otherwise throw out of `runEndOfDayJob` and lose the day's
    // auto-attend, quota deduction and `job_runs` row to a bookkeeping read.
    expect(CODE_OTHER).toContain("try {");
    expect(CODE_OTHER).toContain("} catch (e) {");
    expect(CODE_OTHER.indexOf("try {")).toBeLessThan(CODE_OTHER.indexOf("boItem.findFirst"));
    // …and rule 2: never silently. The booking id is in the message so it can be posted by hand.
    expect(POST_OTHER).toContain("could not read the catalogue for booking ${b.id}");
  });
});

describe("🔴 the SAME `rev:<bookingId>` key as every other day-end post", () => {
  test("อื่นๆ uses it, so SPEC-069's warning covers it with no second lookup and no type list", () => {
    expect(POST_OTHER).toContain("const idempotencyKey = `rev:${b.id}`");
    // …and there is exactly one key expression in the whole อื่นๆ path — not one per branch.
    expect(POST_OTHER.match(/rev:\$\{/g)).toHaveLength(1);
  });

  test("idempotency is the SAME shape as `recordSale`: up-front read + the unique index behind it", () => {
    expect(POST_BOOKING_SALE).toContain("m.idempotencyKey, opts.idempotencyKey");
    expect(POST_BOOKING_SALE).toContain('return { ok: true, skipped: "duplicate" }');
    expect(POST_BOOKING_SALE).toContain('pgErrorCode(e) === "23505"');
  });
});

describe("the `other-booking` catalogue entry", () => {
  test("it exists and is a known sale item, so a post can never go nowhere", () => {
    expect(isKnownSaleItem(OTHER_BOOKING_REF)).toBe(true);
  });

  test("🔴 its price is a placeholder — and the ROW says so, not just a comment in this repo", () => {
    // `ensure-sale-items.ts` stamps every seeded row `priceSource: "owner price card …"`, which would be a lie
    // on this one. Anyone reading `bo.item` sees on the row itself that its price is never the price of anything.
    const seed = SALE_ITEMS.find((i) => i.externalRef === OTHER_BOOKING_REF)!;
    expect(seed.unitPriceMinor).toBe(0);
    expect(String(seed.metadata?.priceSource)).toContain("NOT A PRICE");
    expect(seed.metadata?.amountPerBooking).toBe(true);
  });

  test("`listPriceMinor` reports its placeholder honestly — nothing derives a charge from it", () => {
    expect(listPriceMinor(OTHER_BOOKING_REF)).toBe(0);
    // The อื่นๆ path never asks for it; the amount comes from the booking.
    expect(POST_OTHER).not.toContain("listPriceMinor");
  });

  test("adding it did not disturb the owner's card", () => {
    expect(listPriceMinor("first-trial")).toBe(139000);
    expect(listPriceMinor("session-bike-skate")).toBe(139000);
    expect(listPriceMinor("course-onewheel-10")).toBe(1190000);
  });
});

describe("🔴 the four existing types' posting path is byte-identical", () => {
  test("the อื่นๆ branch is a `continue` at the TOP of the loop — the old path below is untouched", () => {
    const loop = JOBS.slice(JOBS.indexOf("for (const b of attended)"), JOBS.indexOf("const report ="));
    expect(loop).toContain('if (b.bookingType === "OTHER")');
    expect(loop.indexOf('bookingType === "OTHER"')).toBeLessThan(loop.indexOf("resolvePriceGroup"));
    // The trial/single post is the same call it always was.
    expect(loop).toContain("await recordSale(ref, 1, { refId: b.id, idempotencyKey: `rev:${b.id}`, discount })");
  });

  test("`recordSale` itself is untouched — its two rules still stand", () => {
    const recordSale = fn(POST, "export async function recordSale");
    expect(recordSale).toContain("isKnownSaleItem(externalRef)");
    expect(recordSale).toContain("saleMovement(quantity, item.unitPriceMinor)");
    expect(recordSale).not.toContain("OTHER");
  });

  test("the sweep widened by exactly one type", () => {
    expect(JOBS).toContain('inArray(bookings.bookingType, ["FIRST_TRIAL", "SINGLE_SESSION", "OTHER"])');
  });
});

describe("AC-6 — the picker is fed the BACKOFFICE catalogue, not the product codes", () => {
  test("🔴 `getCatalogItems` reads `bo.item`, INCOME + active only", () => {
    // Selling "a course-6" as an อื่นๆ booking would post course revenue with no course behind it (SA ruling,
    // SPEC-070 Q2). EXPENSE items are excluded too — the freelance ceilings live there, and a staff member
    // must not be able to charge a customer against a teacher's budget item.
    const g = fn(SVC, "export async function getCatalogItems");
    expect(g).toContain('eq(boItem.direction, "INCOME")');
    expect(g).toContain("eq(boItem.active, true)");
    expect(g).not.toContain("SALE_ITEMS");
    expect(g).not.toContain("sellablePackages");
  });

  test("it returns only what the picker needs", () => {
    const g = fn(SVC, "export async function getCatalogItems");
    for (const field of ["id: boItem.id", "name: boItem.name", "unitPriceMinor: boItem.unitPriceMinor"]) {
      expect(g).toContain(field);
    }
  });

  test("the route is registered and is a READ", () => {
    expect(API).toContain('.get("/catalog-items"');
    expect(API).toContain("svc.getCatalogItems()");
  });
});

describe("VAT — a typed amount is the FINAL amount", () => {
  test("nothing in the อื่นๆ path adds or derives tax", () => {
    // Every price in `sale-items.ts` is VAT-inclusive (`PRICES_ARE_VAT_INCLUSIVE`); a typed amount is on the
    // same footing. Deriving a net figure here would misstate every report built on top of it.
    //
    // ⚠️ Word-boundary, not substring, and on the CODE only: a bare `toContain("vat")` matches "deacti**vat**ed"
    // in a comment. A guard that fails on an unrelated English word is a guard that gets deleted.
    for (const src of [CODE_OTHER, CODE_POST_BOOKING_SALE]) {
      expect(src).not.toMatch(/\bvat\b/i);
      expect(src).not.toMatch(/1\.07|0\.07|\/ 1\.07/);
    }
  });
});
