// TASK-151 (SPEC-052 / REQ-040) — the gates on a mass delete against a real customer database. Synthetic
// counts only; the point is that the assertions cannot be satisfied by a run that damaged config or left the
// wipe half-done.
import { describe, expect, test } from "bun:test";
import {
  CLEAR_TABLES,
  KEEP_TABLES,
  assertClearEmpty,
  assertKeepUnchanged,
  canCommit,
  formatCountTable,
  totalToClear,
  type Counts,
} from "./db-reset-plan";

const counts = (over: Counts = {}): Counts => {
  const c: Counts = {};
  for (const t of KEEP_TABLES) c[t] = 10;
  for (const t of CLEAR_TABLES) c[t] = 5;
  return { ...c, ...over };
};
const cleared = (over: Counts = {}): Counts => {
  const c = counts();
  for (const t of CLEAR_TABLES) c[t] = 0;
  return { ...c, ...over };
};

describe("the plan itself", () => {
  test("KEEP and CLEAR never overlap — a table cannot be both", () => {
    for (const t of KEEP_TABLES) expect(CLEAR_TABLES).not.toContain(t as never);
  });

  test("FK-restrict order: every child comes before the parent it references", () => {
    const at = (t: string) => CLEAR_TABLES.indexOf(t as never);
    expect(at("booking_badges")).toBeLessThan(at("bookings"));
    expect(at("notification_outbox")).toBeLessThan(at("bookings"));
    expect(at("bookings")).toBeLessThan(at("course_packages"));
    expect(at("bookings")).toBeLessThan(at("vouchers"));
    expect(at("course_packages")).toBeLessThan(at("students"));
    expect(at("vouchers")).toBeLessThan(at("students"));
    expect(at("students")).toBeLessThan(at("parents"));
  });
});

describe("assertKeepUnchanged — config and the roster must survive untouched", () => {
  test("identical KEEP counts pass", () => {
    expect(assertKeepUnchanged(counts(), cleared()).ok).toBe(true);
  });

  test("a single lost teacher fails the run, and says which table", () => {
    const r = assertKeepUnchanged(counts(), cleared({ teachers: 9 }));
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain("teachers");
  });

  test("a KEEP table GAINING rows also fails — unexpected either way", () => {
    expect(assertKeepUnchanged(counts(), cleared({ subjects: 11 })).ok).toBe(false);
  });
});

describe("assertClearEmpty — a partial wipe is not a clean slate", () => {
  test("all zero passes", () => {
    expect(assertClearEmpty(cleared()).ok).toBe(true);
  });

  test("one leftover row fails and names the table", () => {
    const r = assertClearEmpty(cleared({ bookings: 1 }));
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain("bookings");
  });
});

describe("canCommit — the single gate before COMMIT", () => {
  test("a clean run may commit", () => {
    expect(canCommit(counts(), cleared()).ok).toBe(true);
  });

  test("either failure blocks the commit, and both are reported together", () => {
    const r = canCommit(counts(), cleared({ teachers: 0, parents: 3 }));
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(2);
  });

  test("an idempotent second run (already empty) still commits cleanly", () => {
    expect(canCommit(cleared(), cleared()).ok).toBe(true);
    expect(totalToClear(cleared())).toBe(0);
  });
});

describe("operator output", () => {
  test("the table is counts only — no row data can appear in it", () => {
    const out = formatCountTable(counts(), cleared());
    expect(out).toContain("teachers");
    expect(out).toContain("→ 0");
    expect(out).not.toMatch(/[ก-๙]{4,}/); // no Thai names/notes leak through the count table
  });

  test("totalToClear sums only the CLEAR side", () => {
    expect(totalToClear(counts())).toBe(CLEAR_TABLES.length * 5);
  });
});
