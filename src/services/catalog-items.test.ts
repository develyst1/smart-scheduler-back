// SPEC-070 Q2 / TASK-229 — `/catalog-items` must not offer this repo's own seeded sale items.
//
// The whole task is ONE predicate, and the whole risk is SQL's three-valued logic: a backoffice-created item has
// `external_source IS NULL`, and `NULL <> 'smart-scheduler'` evaluates to **NULL, not true**. A plain `ne()`
// would therefore filter out exactly the items this endpoint exists to show — and an empty list reads as
// "the endpoint is broken", not as "the predicate is wrong", so it would be diagnosed in the wrong place.
//
// 🚫 No database. The evidence is the **emitted SQL** (`.toSQL()` is built offline and executes nothing) plus a
// source assertion that the service uses that same construct.
import { describe, expect, test } from "bun:test";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { boItem } from "../db/schema";
import { readSrc } from "../lib/read-src";
import { SALE_ITEMS, SALE_SOURCE } from "../lib/sale-items";

const SVC = readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text());
const SEEDER = readSrc(await Bun.file(new URL("../../scripts/ensure-sale-items.ts", import.meta.url)).text());
const FN = (() => {
  const at = SVC.indexOf("export async function getCatalogItems");
  const rest = SVC.slice(at);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
})();

/** The predicate the service uses, built here so what it COMPILES TO can be read. Nothing is executed. */
const emitted = (where: any) =>
  db.select({ id: boItem.id }).from(boItem).where(where).orderBy(asc(boItem.name)).toSQL().sql;

describe("🔴 the NULL trap — the one thing this task is about", () => {
  test("the chosen construct compiles to `is distinct from`, which is TRUE for a NULL source", () => {
    const sqlText = emitted(sql`${boItem.externalSource} is distinct from ${SALE_SOURCE}`);
    expect(sqlText.toLowerCase()).toContain("is distinct from");
  });

  test("🔴 the naive `ne()` compiles to `<>` — the operator that returns NULL for a NULL column", () => {
    // Documented as evidence rather than as folklore: this is the exact expression that would have shipped an
    // empty picker. `<>` against NULL is NULL, and a NULL predicate excludes the row.
    const naive = emitted(ne(boItem.externalSource, SALE_SOURCE));
    expect(naive).toContain("<>");
    expect(naive.toLowerCase()).not.toContain("is distinct from");
  });

  test("the service uses the safe construct and NOT the naive one", () => {
    expect(FN).toContain("is distinct from");
    expect(FN).not.toContain("ne(boItem.externalSource");
    expect(FN).not.toMatch(/externalSource[^\n]*<>/);
  });

  test("the full predicate still compiles as one AND — the new clause did not displace the old two", () => {
    const full = emitted(
      and(
        eq(boItem.direction, "INCOME"),
        eq(boItem.active, true),
        sql`${boItem.externalSource} is distinct from ${SALE_SOURCE}`,
      ),
    ).toLowerCase();
    expect(full).toContain("direction");
    expect(full).toContain("active");
    expect(full).toContain("is distinct from");
  });
});

describe("what the picker may and may not offer", () => {
  test("🔴 exclusion is by SOURCE, so every current AND future seeded code is covered", () => {
    // The DoD asks this to be asserted "by code, so the next `sale:ensure-items` entry cannot quietly reappear
    // in a staff dropdown". Listing the codes here would be a second list that drifts; what actually gives that
    // guarantee is that `ensure-sale-items.ts` stamps EVERY `SALE_ITEMS` row with `external_source = SALE_SOURCE`
    // and the predicate excludes that source. So the property is: the seeder and the filter agree on one value.
    expect(SEEDER).toContain("externalSource: SALE_SOURCE");
    expect(FN).toContain("SALE_SOURCE");
    // …and the set it covers is non-trivial and includes the codes named in the task.
    const refs = SALE_ITEMS.map((i) => i.externalRef);
    for (const code of ["first-trial", "other-booking", "rental-set"]) expect(refs).toContain(code);
    expect(refs.some((r) => r.startsWith("course-"))).toBe(true);
    expect(refs.some((r) => r.startsWith("voucher-"))).toBe(true);
  });

  test("📌 `other-booking` is excluded too, and that is correct", () => {
    // It is the typed-amount bucket, not something a human picks. It carries `SALE_SOURCE` like every other
    // seeded row, so the one predicate covers it — no special case.
    expect(SALE_ITEMS.some((i) => i.externalRef === "other-booking")).toBe(true);
  });

  test("INCOME + active are unchanged — an EXPENSE or inactive item is still out", () => {
    // The freelance ceilings are EXPENSE items; a staff member must never be able to charge a customer against
    // a teacher's budget.
    expect(FN).toContain('eq(boItem.direction, "INCOME")');
    expect(FN).toContain("eq(boItem.active, true)");
  });

  test("the shape the picker reads is unchanged", () => {
    for (const field of ["id: boItem.id", "name: boItem.name", "unitPriceMinor: boItem.unitPriceMinor"]) {
      expect(FN).toContain(field);
    }
  });
});
