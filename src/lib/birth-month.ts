// TASK-414 (REQ-099) — the People page's BIRTHDAY filter, pure: a birth-MONTH range (the year ignored — a promo month),
// with the wrap-around (11 → 2 = Nov, Dec, Jan, Feb), and the "no DOB recorded" filter (chase the missing ones). Both
// are drizzle conditions on `students.birth_date` that COMPOSE with `searchStudents`' existing terms (the suspended
// exclusion, the archived default) — never replace them.
import { and, asc, isNull, or, sql, type SQL } from "drizzle-orm";
import { students } from "../db/schema";

const month = sql<number>`extract(month from ${students.birthDate})`;
const day = sql<number>`extract(day from ${students.birthDate})`;

/** Is `m` inside the range `from..to` (inclusive), wrapping past December when `from > to`? Pure, for the table pins. */
export function monthInRange(m: number, from: number, to: number): boolean {
  return from <= to ? m >= from && m <= to : m >= from || m <= to;
}

/**
 * `from <= to` ⇒ `month BETWEEN from AND to`; `from > to` (the wrap) ⇒ `month >= from OR month <= to`. A NULL
 * `birth_date` yields a NULL month, which satisfies neither — so "IS NOT NULL" holds by construction.
 */
export function birthMonthWhere(from: number, to: number): SQL {
  return from <= to ? sql`${month} between ${from} and ${to}` : or(sql`${month} >= ${from}`, sql`${month} <= ${to}`)!;
}

/** The "no DOB recorded" filter. */
export const noDobWhere = (): SQL => isNull(students.birthDate);

/**
 * The order INSIDE a range: from `from` around the year, then the day, then the name — so a 11 → 2 range lists
 * November first and February last. The key is `(month - from + 12) % 12`.
 */
export const wrapSortKey = (m: number, from: number): number => (m - from + 12) % 12;
export function birthMonthOrder(from: number) {
  return [asc(sql`((${month} - ${from} + 12) % 12)`), asc(day), asc(students.name)];
}

/** The two filters composed with a base condition (the caller's search + suspended + archived terms). */
export function withBirthdayFilter(base: SQL, f: { birthMonthFrom?: number; birthMonthTo?: number; noDob?: boolean }): SQL {
  if (f.noDob) return and(base, noDobWhere())!;
  if (f.birthMonthFrom !== undefined && f.birthMonthTo !== undefined) return and(base, birthMonthWhere(f.birthMonthFrom, f.birthMonthTo))!;
  return base;
}
