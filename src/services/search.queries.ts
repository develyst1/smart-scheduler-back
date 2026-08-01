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
import { bookings, coursePackages, parents, students, vouchers } from "../db/schema";
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

// ── /bookings ordering (TASK-073) ───────────────────────────────────────────────────────────────────
export type BookingSort = "upcoming" | "date_asc" | "date_desc";

/**
 * How `/bookings` orders its rows. Exported so both directions are testable from the generated SQL.
 *
 * ⚠️ **`upcoming` is not the same thing as `date_desc`, and that distinction is the point of this task.**
 * A 10-session course creates a booking every week for **10 weeks forward** at registration
 * (`courseSessionDates`), so the newest booking in the table is routinely **2–3 months away**. Sorting
 * newest-first would hand staff November when it's August — wrong in the opposite direction from the
 * oldest-first bug it replaces, and just as useless.
 *
 * `upcoming` puts **today and the future first, soonest first**, then the past **most-recent first** — so the
 * top of page 1 is the next thing that happens, and nothing is hidden. It's a pure sort: no filter, no rows
 * removed, `total` unchanged.
 *
 * Every direction ends with `startTime` then **`id`**, so the order is *total*: a merely-nearly-total order
 * lets a row appear on two pages or on none.
 */
export const bookingsOrderBy = (sort: BookingSort, today: string) => {
  if (sort === "date_asc") return [asc(bookings.date), asc(bookings.startTime), asc(bookings.id)];
  if (sort === "date_desc") return [desc(bookings.date), desc(bookings.startTime), asc(bookings.id)];
  return [
    sql`(${bookings.date} < ${today})`, // false (today/future) sorts before true (past)
    sql`case when ${bookings.date} >= ${today} then ${bookings.date} end`, // future: soonest first
    desc(bookings.date), // past: most recent first (NULL above ties them, so this decides)
    asc(bookings.startTime),
    asc(bookings.id),
  ];
};
