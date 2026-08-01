// SPEC-025 / TASK-079 — importing an entitlement a family is already part-way through.
//
// The arithmetic is the balance, not the history: we create the sessions still owed, never the ones already
// taught (we don't have that history, and inventing it would put fictional attendance in the reports).
import { describe, expect, test } from "bun:test";
import { courseSessionDates, remainingSessions } from "./recurring";
import { ATTENTION_CHECKS, isSaleUnposted } from "./attention";
import { soldCoursesSince, soldVouchersSince } from "../services/search.queries";

describe("remainingSessions — the balance", () => {
  test("🔑 the task's example: 10 bought, 4 used → 6 remain", () => {
    expect(remainingSessions(10, 4)).toBe(6);
  });

  test("🔴 a finished course imports with ZERO future bookings, never a negative count", () => {
    // Sober's call: staff may still want the record, so this creates the course with no sessions rather
    // than refusing. A negative would become a negative loop bound.
    expect(remainingSessions(10, 10)).toBe(0);
    expect(remainingSessions(10, 12)).toBe(0);
  });

  test("nothing used yet → the whole course remains", () => {
    expect(remainingSessions(6, 0)).toBe(6);
  });

  test("junk input can't produce a negative or fractional count", () => {
    expect(remainingSessions(10, -3)).toBe(10);
    expect(remainingSessions(6.7, 1.2)).toBe(5);
  });

  test("🔑 the remaining count drives the bookings created — 6 dates, weekly, from the resume date", () => {
    const dates = courseSessionDates("2026-08-20", remainingSessions(10, 4));
    expect(dates).toHaveLength(6);
    expect(dates[0]).toBe("2026-08-20");
    expect(dates[5]).toBe("2026-09-24"); // 5 weeks later
  });

  test("a finished course produces no dates at all", () => {
    expect(courseSessionDates("2026-08-20", remainingSessions(4, 4))).toHaveLength(0);
  });
});

describe("🔴 the sales_not_posted detector must survive go-live", () => {
  test("the check is still registered — imports are excluded by the QUERY, not by removing the check", () => {
    // The exclusion lives in the loader's WHERE (`source = 'SALE'`). If someone ever "fixes" the go-live
    // noise by deleting the check instead, this fails and says so.
    expect(ATTENTION_CHECKS.some((c) => c.key === "sales_not_posted")).toBe(true);
  });
});

describe("🔴 the exclusion is provable, and it does NOT break the check", () => {
  const sqlOf = (q: { toSQL: () => { sql: string; params: unknown[] } }) => q.toSQL();

  test("🔑 imported entitlements are excluded — `source = 'SALE'` is in BOTH candidate queries", () => {
    for (const q of [soldCoursesSince("2026-08-01"), soldVouchersSince("2026-08-01")]) {
      const { sql, params } = sqlOf(q);
      expect(sql).toContain('"source"');
      expect(params).toContain("SALE"); // ← the filter that keeps go-live morning quiet
    }
  });

  test("🔑 …and it still flags a GENUINE unposted sale — the exclusion isn't 'switch the check off'", () => {
    // Same predicate the check uses. A SALE-sourced course with no movement is still counted; without this
    // half of the test, an exclusion and a broken check look identical.
    const posted = new Set(["course-posted"]);
    expect(isSaleUnposted({ id: "course-unposted" }, posted)).toBe(true);
    expect(isSaleUnposted({ id: "course-posted" }, posted)).toBe(false);
  });

  test("the window filter survives alongside the source filter — both conditions, not one", () => {
    const { sql, params } = sqlOf(soldCoursesSince("2026-07-25"));
    expect(sql).toContain("created_at");
    expect(params).toContain("2026-07-25");
    expect(params).toContain("SALE");
  });
});
