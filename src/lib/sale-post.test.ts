// TASK-066 — what can be proven without a database. The insert itself is deploy smoke (brownfield);
// the two things that can be wrong *in code* are the sign rule and the unknown-code guard.
import { describe, expect, test } from "bun:test";
import { netPostedSale, recordSale, saleMovement } from "./sale-post";
import { readSrc } from "./read-src";
import { FIRST_TRIAL_MINOR, courseItemRef } from "./sale-items";

describe("sign rule — must match backoffice-back's bo-money.ts or the P&L reads backwards", () => {
  test("🔑 a sale is an OUT (qty negative) worth a POSITIVE value on an INCOME item", () => {
    const m = saleMovement(1, FIRST_TRIAL_MINOR);
    expect(m.qty).toBe(-1);
    expect(m.valueMinor).toBe(FIRST_TRIAL_MINOR);
    expect(m.valueMinor).toBeGreaterThan(0); // negative here = revenue subtracted from the month
  });

  test("value scales with quantity", () => {
    expect(saleMovement(3, 1000).valueMinor).toBe(3000);
    expect(saleMovement(3, 1000).qty).toBe(-3);
  });

  test("a caller passing a positive OR negative quantity both mean 'one sold'", () => {
    // Defensive: `recordSale(ref, 1)` is the only call shape today, but a −1 must never invert
    // the movement into a refund that quietly reduces the month's revenue.
    expect(saleMovement(-1, 5000)).toEqual(saleMovement(1, 5000));
  });

  test("a zero-priced item posts zero — the reason prices must never default to 0", () => {
    expect(saleMovement(1, 0).valueMinor).toBe(0);
  });
});

describe("unknown product code is loud, not silent", () => {
  test("🔑 returns unknown-code and writes nothing — no DB call is even attempted", async () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a[0]);
    try {
      // "course-8" is the unconfirmed 8-week assumption in the workspace CLAUDE.md — a plausible
      // string that is NOT a product. It must not reach the DB and must not pass quietly.
      const r = await recordSale("course-8", 1, { refId: "c1" });
      expect(r).toEqual({ ok: false, skipped: "unknown-code" });
      expect(String(errors[0])).toContain("NOT POSTED");
      expect(String(errors[0])).toContain("course-8");
    } finally {
      console.error = orig;
    }
  });

  test("a real code gets past the guard (it then needs a DB, which is deploy smoke)", () => {
    // Proves the guard isn't rejecting everything — the failure mode that would make the test above
    // pass for the wrong reason.
    expect(courseItemRef("onewheel", 6)).toBe("course-onewheel-6");
  });
});

// ═══ SPEC-069 / TASK-221 — the READ side: was this booking's revenue already posted? ═══
//
// The netting and the SIGN are the parts that can be wrong in code, so they are pure and tested here. The query
// itself needs `bo.movement` rows and is deploy smoke, like `recordSale`'s insert — but *what* it looks the sale
// up BY is a source claim worth pinning: inferring it from booking type/status/date would be a second copy of a
// rule that lives in the day-end job, and the two would drift.
//
// Read at module top level — a `describe` callback is not a module scope, so `await` is not allowed inside it.
const SRC = readSrc(await Bun.file(new URL("./sale-post.ts", import.meta.url)).text());
const API = readSrc(await Bun.file(new URL("../routes/api.ts", import.meta.url)).text());
const FN = (() => {
  const at = SRC.indexOf("export async function postedSaleForBooking");
  const rest = SRC.slice(at);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
})();

describe("SPEC-069 / TASK-221 — netting a posted sale", () => {
  const at = new Date("2026-08-29T16:30:00.000Z");

  test("🔑 a ฿1,390 trial with no discount reads 139000, POSITIVE", () => {
    // A flipped sign here is invisible until month end, and would render the warning as a negative amount.
    const p = netPostedSale({ listMinor: 139000, discountMinor: 0, productCode: "first-trial", postedAt: at });
    expect(p.amountMinor).toBe(139000);
    expect(p.amountMinor).toBeGreaterThan(0);
    expect(p.listMinor).toBe(139000);
    expect(p.productCode).toBe("first-trial");
    expect(p.postedAt).toBe("2026-08-29T16:30:00.000Z");
  });

  test("🔴 a DISCOUNTED trial nets to the discounted amount — never the list price", () => {
    // The discount rides the same sale as a `discount:<refId>` movement with `valueMinor = −discountMinor`
    // (`discount-plan.ts`). Warning a family with ฿1,390 when ฿1,190 was posted sends someone to reverse the
    // wrong number.
    const p = netPostedSale({
      listMinor: 139000,
      discountMinor: -20000, // the movement's OWN value, as stored
      productCode: "first-trial",
      postedAt: at,
    });
    expect(p.amountMinor).toBe(119000);
    expect(p.amountMinor).not.toBe(p.listMinor);
    expect(p.discountMinor).toBe(-20000);
  });

  test("the netting is `list + discount` — the same addition the P&L does, not a second rule", () => {
    // `bo-money.ts:17`: amount = ΣOUT − Σ(reversal IN), expressed as an addition of signed values. Writing a
    // subtraction here would be a second arithmetic that has to be kept in step with that one by hand.
    for (const [list, disc] of [
      [139000, 0],
      [139000, -20000],
      [65000, -65000], // fully discounted: posted, and worth nothing
    ] as const) {
      expect(netPostedSale({ listMinor: list, discountMinor: disc, productCode: "x", postedAt: at }).amountMinor).toBe(
        list + disc,
      );
    }
  });

  test("a fully-discounted sale still reads as POSTED — `0` is not `null`", () => {
    // "posted ฿0" and "nothing posted" are different facts, and the dialog must not conflate them.
    expect(netPostedSale({ listMinor: 65000, discountMinor: -65000, productCode: "x", postedAt: at }).amountMinor).toBe(0);
  });

  test("🔴 the NEGATIVE-discount contract is documented where a consumer will read it", () => {
    // SA ruling (TASK-221 → TASK-222): render `amountMinor`, never re-derive it. `list - discountMinor` on a
    // negative value yields a HIGHER number than the truth — on a warning whose whole job is the number.
    const iface = SRC.slice(SRC.indexOf("export interface PostedSale"), SRC.indexOf("export function netPostedSale"));
    expect(iface).toContain("NEGATIVE");
    expect(iface).toContain("re-deriving");
  });
});

describe("SPEC-069 / TASK-221 — how the sale is FOUND (source claims)", () => {
  test("🔴 detection is by IDEMPOTENCY KEY — no booking-type list, no status or date condition", () => {
    expect(FN).toContain("`rev:${bookingId}`");
    expect(FN).toContain("boMovement.idempotencyKey");
    for (const inferred of ["bookingType", "FIRST_TRIAL", "SINGLE_SESSION", "ATTENDED", "status", "date"]) {
      expect(FN).not.toContain(inferred);
    }
  });

  test("the discount sibling is looked up by its own key, on the same booking", () => {
    expect(FN).toContain("`discount:${bookingId}`");
  });

  test("🔴 it does NOT catch — a swallowed error would render as 'no money posted'", () => {
    // The rest of this file is best-effort by design (a sale must never fail the booking it describes). This
    // read is the opposite: it IS the warning, so it must be allowed to fail loudly.
    expect(FN).not.toContain("catch");
    expect(FN).not.toContain("return { posted: null }");
  });

  test("🔴 it writes NOTHING — this endpoint adds no way to move money", () => {
    for (const write of ["insert(", "update(", "delete("]) expect(FN).not.toContain(write);
  });

  test("the route is registered and returns `{ posted }`, with no try/catch of its own", () => {
    const route = API.slice(API.indexOf('.get("/bookings/:id/posted-sale"'));
    const decl = route.slice(0, route.indexOf("\n  )") + 3);
    expect(decl).toContain("{ posted: await postedSaleForBooking(");
    expect(decl).not.toContain("catch");
  });
});
