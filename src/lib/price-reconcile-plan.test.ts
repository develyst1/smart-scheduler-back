// TASK-158 Part B (SPEC-058 / REQ-061) — the price-reconcile decision. This is a LIVE MONEY tool, so what is
// tested is mostly what it must NOT do: never create, never delete, never touch a price that already matches.
import { describe, expect, test } from "bun:test";
import { formatReconcilePlan, planPriceReconcile, type StoredItem } from "./price-reconcile-plan";
import { SALE_ITEMS } from "./sale-items";

const cat = [
  { externalRef: "course-onewheel-6", name: "Onewheel 6h", unitPriceMinor: 790000 },
  { externalRef: "course-onewheel-10", name: "Onewheel 10h", unitPriceMinor: 1190000 },
] as any;
const stored = (over: Partial<StoredItem> = {}): StoredItem => ({
  externalRef: "course-onewheel-6",
  name: "Onewheel 6h",
  unitPriceMinor: 799000, // the stale 7,990 both boxes hold
  ...over,
});

describe("what it changes", () => {
  test("a stale stored price is a change, with BOTH numbers", () => {
    const p = planPriceReconcile([stored()], cat);
    expect(p.changes).toEqual([
      { externalRef: "course-onewheel-6", name: "Onewheel 6h", from: 799000, to: 790000 },
    ]);
    expect(formatReconcilePlan(p)).toContain("7,990.00 → 7,900.00");
  });

  test("a price that already matches is left alone and counted as matching", () => {
    const p = planPriceReconcile([stored({ unitPriceMinor: 790000 })], cat);
    expect(p.changes).toEqual([]);
    expect(p.matching).toEqual(["course-onewheel-6"]);
  });

  test("🔑 a second run finds nothing — idempotent", () => {
    const after = [stored({ unitPriceMinor: 790000 }), stored({ externalRef: "course-onewheel-10", unitPriceMinor: 1190000 })];
    expect(planPriceReconcile(after, cat).changes).toHaveLength(0);
  });
});

describe("what it deliberately does NOT do", () => {
  test("a catalogue item with no stored row is REPORTED, never created — that is `ensure-items`' job", () => {
    const p = planPriceReconcile([stored()], cat);
    expect(p.missing).toEqual(["course-onewheel-10"]);
    expect(p.changes.map((c) => c.externalRef)).not.toContain("course-onewheel-10");
    expect(formatReconcilePlan(p)).toContain("sale:ensure-items");
  });

  test("a stored code no longer in the catalogue is reported as an orphan, never deleted", () => {
    const p = planPriceReconcile([stored(), stored({ externalRef: "course-retired-4" })], cat);
    expect(p.orphans).toEqual(["course-retired-4"]);
    expect(p.changes.map((c) => c.externalRef)).not.toContain("course-retired-4");
  });

  test("nothing but a price can be produced — the plan carries no other field to write", () => {
    const c = planPriceReconcile([stored()], cat).changes[0]!;
    expect(Object.keys(c).sort()).toEqual(["externalRef", "from", "name", "to"]);
  });
});

describe("against the real catalogue (REQ-061 Part A)", () => {
  test("the corrected onewheel prices are in `SALE_ITEMS` and would be reconciled from the stale ones", () => {
    const six = SALE_ITEMS.find((i) => i.externalRef === "course-onewheel-6")!;
    const ten = SALE_ITEMS.find((i) => i.externalRef === "course-onewheel-10");
    expect(six.unitPriceMinor).toBe(790000); // 7,900 — was 7,990
    expect(ten?.unitPriceMinor).toBe(1190000); // 11,900 — did not exist before
    const p = planPriceReconcile([{ externalRef: six.externalRef, name: six.name, unitPriceMinor: 799000 }]);
    expect(p.changes[0]).toMatchObject({ externalRef: "course-onewheel-6", from: 799000, to: 790000 });
    expect(p.missing).toContain("course-onewheel-10"); // ensure-items creates it first
  });
});
