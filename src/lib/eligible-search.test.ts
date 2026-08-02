// TASK-088 — `q` on GET /students/eligible.
//
// The rule under test is "q NARROWS, never widens", plus the contract. The search itself is deliberately not
// re-implemented here: it resolves through `studentSearchQuery` → `studentSearchConditions`, the same rule
// /students and /bookings use, whose SQL is already asserted in services/search-paging.test.ts.
import { describe, expect, test } from "bun:test";
import { matchesSearch } from "./eligibility";
import { eligibleStudentsQuery } from "../validation";
import { studentSearchQuery } from "../services/search.queries";
import { studentSearchConditions } from "../services/parent.service";

describe("matchesSearch — q narrows, it can never widen", () => {
  test("🔑 no search term → everything eligible passes, response unchanged", () => {
    expect(matchesSearch("any-student", null)).toBe(true);
  });

  test("with a term, only the resolved ids pass", () => {
    const matching = new Set(["stu-a"]);
    expect(matchesSearch("stu-a", matching)).toBe(true);
    expect(matchesSearch("stu-b", matching)).toBe(false);
  });

  test("🔴 an empty result set narrows to nothing — it never falls back to 'show everyone'", () => {
    // The dangerous failure would be treating "no matches" as "no filter". A search that silently returns
    // the full list is how staff book the wrong child.
    expect(matchesSearch("stu-a", new Set())).toBe(false);
  });

  test("🔑 a PARENTLESS student passes purely on being in the resolved set", () => {
    // The walk-in carve-out lives in the LEFT JOIN inside `studentSearchQuery`; this rule adds no second
    // condition that could drop them. Fourth time this cohort has come up — it stays safe by construction.
    expect(matchesSearch("walk-in", new Set(["walk-in"]))).toBe(true);
  });
});

describe("🔑 the rule is SHARED, not re-implemented for this endpoint", () => {
  test("the query this path uses matches name · nickname · parent phone", () => {
    const { sql, params } = studentSearchQuery("0812345678").toSQL();
    expect(sql).toContain('"name"');
    expect(sql).toContain('"nickname"');
    expect(sql).toContain('"phone"');
    expect(params).toContain("%0812345678%");
  });

  test("…and it LEFT joins parents, so a walk-in student is still findable", () => {
    const { sql } = studentSearchQuery("น้องเอ").toSQL();
    expect(sql).toContain("left join");
    expect(sql).not.toContain('inner join "parents"');
  });

  test("it is literally studentSearchConditions — same condition count, phone-conditional", () => {
    expect(studentSearchConditions("0812345678")).toHaveLength(3);
    expect(studentSearchConditions("น้องเอ")).toHaveLength(2);
  });
});

describe("contract — q is additive, type stays required", () => {
  test("q is optional; omitting it parses exactly as before", () => {
    const r = eligibleStudentsQuery.safeParse({ type: "VOUCHER" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.q).toBeUndefined();
  });

  test("q is accepted and trimmed", () => {
    const r = eligibleStudentsQuery.safeParse({ type: "COURSE_PACKAGE", q: "  เอ  " });
    expect(r.success && r.data.q).toBe("เอ");
  });

  test("🔴 type stays required and an unsupported value is still a 400 — unchanged by TASK-088", () => {
    expect(eligibleStudentsQuery.safeParse({ q: "เอ" }).success).toBe(false);
    expect(eligibleStudentsQuery.safeParse({ type: "FIRST_TRIAL" }).success).toBe(false);
  });
});
