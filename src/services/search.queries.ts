// TASK-070 — how the three list endpoints search and order. ONE home, so "the same query works everywhere"
// is a property of the code rather than a convention people have to remember.
//
// All three build their student filter from **`studentSearchConditions`** (REQ-011: name · nickname · parent
// phone). Before this, `/bookings` had its own `ilike(students.name, …)` — which is why the same term found a
// child in the picker and nothing in the bookings list, and staff reasonably read that as the system being
// broken.
//
// ⚠️ **Every one of these LEFT joins `parents`.** A walk-in / First-Trial student has `parent_id = null`
// **by design**; an inner join would delete that whole cohort from every search box in the app. Same failure
// as the badge report. Do not "tidy" these into inner joins.
//
// These are query *builders* (not awaited) so their SQL — the shared rule and the ordering — is testable
// without a database, the way `lastDigestRunQuery` is.

import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { db } from "../db";
import { coursePackages, parents, students, vouchers } from "../db/schema";
import { studentSearchConditions } from "./parent.service";

/** The student-side filter. `true` when there's no term, so the same builder serves the unfiltered path. */
export const studentMatch = (q?: string) =>
  q?.trim() ? or(...studentSearchConditions(q)) : sql`true`;

/** Student ids matching a free-text term — used to resolve `/bookings?q=`. */
export const studentSearchQuery = (q: string) =>
  db
    .select({ id: students.id })
    .from(students)
    .leftJoin(parents, eq(parents.id, students.parentId))
    .where(or(...studentSearchConditions(q)));

/**
 * Course ids in the ONE canonical order — student name, then the course's own `createdAt`, then `id` as a
 * final tiebreak so the ordering is total.
 *
 * There was **no `ORDER BY` at all` before this**, so identical requests could return cards in different
 * orders. A deterministic order is what makes paging mean anything.
 */
export const courseSearchQuery = (q?: string) =>
  db
    .select({ id: coursePackages.id })
    .from(coursePackages)
    .innerJoin(students, eq(students.id, coursePackages.studentId))
    .leftJoin(parents, eq(parents.id, students.parentId))
    .where(studentMatch(q))
    .orderBy(asc(students.name), asc(coursePackages.createdAt), asc(coursePackages.id));

/** Voucher ids, newest first, `id` breaking ties so paging is stable. */
export const voucherSearchQuery = (f: { studentId?: string; q?: string } = {}) => {
  const conds = [studentMatch(f.q)];
  if (f.studentId) conds.push(eq(vouchers.studentId, f.studentId));
  return db
    .select({ id: vouchers.id })
    .from(vouchers)
    .innerJoin(students, eq(students.id, vouchers.studentId))
    .leftJoin(parents, eq(parents.id, students.parentId))
    .where(and(...conds))
    .orderBy(desc(vouchers.createdAt), asc(vouchers.id));
};

/** Row counts for the paged endpoints — same joins and same filter, so `total` can't disagree with `items`. */
export const courseCountQuery = (q?: string) =>
  db
    .select({ value: sql<number>`count(*)::int` })
    .from(coursePackages)
    .innerJoin(students, eq(students.id, coursePackages.studentId))
    .leftJoin(parents, eq(parents.id, students.parentId))
    .where(studentMatch(q));

export const voucherCountQuery = (f: { studentId?: string; q?: string } = {}) => {
  const conds = [studentMatch(f.q)];
  if (f.studentId) conds.push(eq(vouchers.studentId, f.studentId));
  return db
    .select({ value: sql<number>`count(*)::int` })
    .from(vouchers)
    .innerJoin(students, eq(students.id, vouchers.studentId))
    .leftJoin(parents, eq(parents.id, students.parentId))
    .where(and(...conds));
};
