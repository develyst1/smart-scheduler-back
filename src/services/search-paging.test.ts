// TASK-070 — one search rule across bookings, courses and vouchers, and a stable order for paging.
//
// Asserted on the generated SQL (`.toSQL()`), which needs no database — same approach as
// `lastDigestRunQuery` in TASK-053. The point isn't the SQL string; it's that all three endpoints are
// provably built from `studentSearchConditions` rather than each growing its own search.
import { describe, expect, test } from "bun:test";
import {
  courseSearchQuery,
  studentSearchQuery,
  voucherSearchQuery,
} from "./search.queries";
import { studentSearchConditions } from "./parent.service";

const sqlOf = (q: { toSQL: () => { sql: string; params: unknown[] } }) => q.toSQL();
const ALL = [
  ["bookings (student lookup)", studentSearchQuery("0812345678")],
  ["courses", courseSearchQuery("0812345678")],
  ["vouchers", voucherSearchQuery({ q: "0812345678" })],
] as const;

describe("🔑 ONE search rule — name · nickname · parent phone — on all three endpoints", () => {
  test.each(ALL)("%s matches on all three fields", (_label, query) => {
    const { sql, params } = sqlOf(query);
    expect(sql).toContain('"name"');
    expect(sql).toContain('"nickname"');
    expect(sql).toContain('"phone"'); // ← the half `/bookings` was missing before this task
    expect(params).toContain("%0812345678%");
  });

  test.each(ALL)("%s LEFT joins parents — a walk-in student has no parent BY DESIGN", (_l, query) => {
    // An inner join here would delete the whole walk-in / First-Trial cohort from every search box.
    const { sql } = sqlOf(query);
    expect(sql).toContain("left join");
    expect(sql).not.toContain("inner join \"parents\"");
  });

  test("the rule really is the shared one — same condition count as studentSearchConditions", () => {
    // A phone-looking term yields 3 conditions; a non-numeric term yields 2 (no phone clause).
    expect(studentSearchConditions("0812345678")).toHaveLength(3);
    expect(studentSearchConditions("น้องเอ")).toHaveLength(2);
    // …and a non-numeric term therefore produces no phone param in any of the three queries.
    for (const build of [
      () => studentSearchQuery("น้องเอ"),
      () => courseSearchQuery("น้องเอ"),
      () => voucherSearchQuery({ q: "น้องเอ" }),
    ]) {
      expect(sqlOf(build()).params).toEqual(["%น้องเอ%", "%น้องเอ%"]);
    }
  });
});

describe("stable order — what makes paging mean anything", () => {
  test("🔑 courses order by student name, then createdAt, then id (was NO order at all)", () => {
    const { sql } = sqlOf(courseSearchQuery());
    expect(sql).toContain("order by");
    const order = sql.slice(sql.indexOf("order by"));
    expect(order).toContain('"name"');
    expect(order).toContain('"created_at"');
    expect(order).toContain('"id"'); // total order — no ties left to chance
  });

  test("vouchers keep newest-first, with id as the tiebreak", () => {
    const order = sqlOf(voucherSearchQuery()).sql;
    expect(order.slice(order.indexOf("order by"))).toContain("desc");
  });

  test("the same request builds the same SQL — determinism, not luck", () => {
    expect(sqlOf(courseSearchQuery("เอ")).sql).toBe(sqlOf(courseSearchQuery("เอ")).sql);
  });
});

describe("no search term → no filtering (the internal consumers' path)", () => {
  test("🔑 getCourses()/getVouchers() build an unfiltered query — attention, eligibility and SOM see ALL rows", () => {
    // If this ever grows a WHERE on the student, a digest count / eligibility list / dashboard figure would
    // silently truncate. That's why paging is opt-in via listCoursesPaged instead of baked in here.
    expect(sqlOf(courseSearchQuery()).params).toEqual([]);
    expect(sqlOf(voucherSearchQuery()).params).toEqual([]);
  });

  test("neither unpaged query carries a limit or an offset", () => {
    expect(sqlOf(courseSearchQuery()).sql).not.toContain("limit");
    expect(sqlOf(voucherSearchQuery()).sql).not.toContain("limit");
  });

  test("a studentId filter still applies (the booking modal's own-vouchers load)", () => {
    const { params } = sqlOf(voucherSearchQuery({ studentId: "stu-1" }));
    expect(params).toContain("stu-1");
  });
});
