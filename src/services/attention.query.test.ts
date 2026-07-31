// TASK-053 REWORK item 1 — pin the "last digest run" ORDERING contract.
//
// The bug: `orderBy(runDate).limit(500)` is ASCENDING, so it kept the OLDEST 500 rows and `.at(-1)` returned
// the 500th-oldest. After ~500 daily rows the panel would have frozen on a year-old date while looking
// healthy — the indicator lying in exactly the direction it exists to prevent.
//
// A live "a later row wins" assertion needs a database (deploy smoke). What IS provable here without one is
// the query itself: Drizzle can render it via `.toSQL()`, so this test fails if anyone drops a `desc`, drops
// the tie-breaker, or restores a wide `limit`.
import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { lastDigestRunQuery } = await import("./attention.service");

describe("lastDigestRunQuery — newest row, unambiguously (TASK-053 item 1)", () => {
  const sql = lastDigestRunQuery().toSQL().sql.toLowerCase();

  test("orders by run_date DESC — the newest business date, not the oldest", () => {
    expect(sql).toMatch(/order by[\s\S]*"run_date" desc/);
  });

  test("tie-breaks on finished_at DESC — a re-run supersedes the earlier row for the SAME date", () => {
    // e.g. a clear 08:00 run (sent:false) followed by a re-run once something came up (sent:true)
    expect(sql).toMatch(/order by[\s\S]*"finished_at" desc/);
    const order = sql.slice(sql.indexOf("order by"));
    expect(order.indexOf("run_date")).toBeLessThan(order.indexOf("finished_at")); // run_date is primary
  });

  test("takes exactly one row (no wide limit to scan past)", () => {
    expect(sql).toMatch(/limit \$?\d?/);
    expect(lastDigestRunQuery().toSQL().params).toContain(1);
  });

  test("still scoped to the digest job", () => {
    expect(sql).toContain('"job"');
    expect(lastDigestRunQuery().toSQL().params).toContain("daily-digest");
  });
});
