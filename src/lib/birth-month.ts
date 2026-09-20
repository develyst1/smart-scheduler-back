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

// ───────────── TASK-416 (REQ-099 + years) — the DATED branch ─────────────
/** The first day of a month as ISO (`YYYY-MM-01`) and the last day (the whole To month included). Pure, for the table pins. */
export const monthStart = (y: number, m: number): string => `${y}-${String(m).padStart(2, "0")}-01`;
export function monthEnd(y: number, m: number): string {
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of the NEXT month = the last day of this one
  return d.toISOString().slice(0, 10);
}

/** Is the ISO date inside `[monthStart(yf, mf), monthEnd(yt, mt)]`? Pure (a dated range cannot wrap). */
export const dateInRange = (iso: string, yf: number, mf: number, yt: number, mt: number): boolean => iso >= monthStart(yf, mf) && iso <= monthEnd(yt, mt);

/**
 * With years: `birth_date BETWEEN make_date(yf, mf, 1) AND (make_date(yt, mt, 1) + interval '1 month' - interval '1 day')`
 * — the whole To month, no wrap (the validator refuses `from > to`). NULL never satisfies a BETWEEN.
 */
export function birthDateRangeWhere(yf: number, mf: number, yt: number, mt: number): SQL {
  return sql`${students.birthDate} between make_date(${yf}, ${mf}, 1) and (make_date(${yt}, ${mt}, 1) + interval '1 month' - interval '1 day')`;
}
/** A dated range orders by the date itself, then the name. */
export function birthDateOrder() {
  return [asc(students.birthDate), asc(students.name)];
}

export interface BirthdayFilter { birthMonthFrom?: number; birthMonthTo?: number; birthYearFrom?: number; birthYearTo?: number; noDob?: boolean }
/** Which branch a filter takes — the ONE decision the where and the order both read. */
export function birthdayMode(f: BirthdayFilter): "none" | "noDob" | "month" | "date" {
  if (f.noDob) return "noDob";
  if (f.birthMonthFrom === undefined || f.birthMonthTo === undefined) return "none";
  return f.birthYearFrom !== undefined && f.birthYearTo !== undefined ? "date" : "month";
}

/** The filters composed with a base condition (the caller's search + suspended + archived terms). */
export function withBirthdayFilter(base: SQL, f: BirthdayFilter): SQL {
  switch (birthdayMode(f)) {
    case "noDob": return and(base, noDobWhere())!;
    case "date": return and(base, birthDateRangeWhere(f.birthYearFrom!, f.birthMonthFrom!, f.birthYearTo!, f.birthMonthTo!))!;
    case "month": return and(base, birthMonthWhere(f.birthMonthFrom!, f.birthMonthTo!))!;
    default: return base;
  }
}
/** The order that goes with the branch: dated ⇒ the date; month-only ⇒ the wrap key; else the name. */
export function birthdayOrder(f: BirthdayFilter) {
  switch (birthdayMode(f)) {
    case "date": return birthDateOrder();
    case "month": return birthMonthOrder(f.birthMonthFrom!);
    default: return [asc(students.name)];
  }
}
