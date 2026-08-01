// Pure bucketing for the SOM dashboard (REQ-013 / TASK-062). Everything here is a function over rows — no DB,
// no SQL cleverness — so each rule is tested independently of the query that feeds it.
//
// ⚠️ The governing rule: **unknown is a first-class category.** `students.parent_id` is nullable by design
// (walk-in / First-Trial) and gender/DOB/nationality are all optional, so a breakdown that quietly drops them
// would delete the walk-in cohort and flatter every percentage — the badge-report failure, repeated. Every
// breakdown therefore carries an explicit `unknown` bucket AND `{known, unknown, total}` so the FE can say
// "based on 12 of 48 students".

export interface BreakdownBucket {
  key: string;
  label?: string;
  count: number;
}
export interface Breakdown {
  buckets: BreakdownBucket[];
  known: number;
  unknown: number;
  total: number;
}

export const UNKNOWN_KEY = "unknown";

/**
 * Group rows by a key, treating null/undefined/blank as **unknown**. The `unknown` bucket is **always present**
 * (even at 0) so the FE never has to infer it. Known buckets are sorted by count desc, then key, for a stable
 * render.
 */
export function breakdown<T>(
  items: T[],
  keyOf: (item: T) => string | null | undefined,
  labelOf?: (key: string) => string | undefined,
): Breakdown {
  const counts = new Map<string, number>();
  let unknown = 0;
  for (const item of items) {
    const raw = keyOf(item);
    const key = typeof raw === "string" ? raw.trim() : raw;
    if (!key) {
      unknown++;
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const buckets: BreakdownBucket[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, label: labelOf?.(key), count }));
  const known = items.length - unknown;
  buckets.push({ key: UNKNOWN_KEY, label: "ไม่ระบุ", count: unknown });
  return { buckets, known, unknown, total: items.length };
}

/** Whole years from a `YYYY-MM-DD` DOB at `today`. null when there's no (or an invalid) DOB. */
export function ageFrom(birthDate: string | null | undefined, today: string): number | null {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  if (!by || !bm || !bd || !ty || !tm || !td) return null;
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--; // birthday not reached yet this year
  return age < 0 ? null : age;
}

/** Age bands for a kids' sports centre. Chosen here (the REQ doesn't fix them) — one place to change. */
export const AGE_BANDS: Array<{ key: string; min: number; max: number }> = [
  { key: "0-5", min: 0, max: 5 },
  { key: "6-9", min: 6, max: 9 },
  { key: "10-12", min: 10, max: 12 },
  { key: "13-15", min: 13, max: 15 },
  { key: "16-17", min: 16, max: 17 },
  { key: "18+", min: 18, max: Infinity },
];

/** Band key for a DOB, or null (→ the unknown bucket) when the DOB is missing. Age is **derived at read time,
 *  never stored** — the SPEC-016 rule. */
export function ageBand(birthDate: string | null | undefined, today: string): string | null {
  const age = ageFrom(birthDate, today);
  if (age === null) return null;
  return AGE_BANDS.find((b) => age >= b.min && age <= b.max)?.key ?? null;
}

export interface SportBooking {
  subjectId: string | null | undefined;
  subjectName?: string | null;
  date: string;
  startTime?: string;
}

/**
 * A student's **primary** sport: the subject they have the most bookings in, ties broken by the **most recent**
 * booking. Returns null when they have no bookings (→ unknown), so a brand-new student can't break the share.
 * One student contributes exactly one unit, which is what makes the shares sum to 100%.
 */
export function primarySport(
  bookings: SportBooking[],
): { id: string; name: string | null } | null {
  const agg = new Map<string, { count: number; latest: string; name: string | null }>();
  for (const b of bookings) {
    if (!b.subjectId) continue;
    const stamp = `${b.date} ${b.startTime ?? ""}`;
    const cur = agg.get(b.subjectId);
    if (!cur) {
      agg.set(b.subjectId, { count: 1, latest: stamp, name: b.subjectName ?? null });
    } else {
      cur.count++;
      if (stamp > cur.latest) cur.latest = stamp;
    }
  }
  if (!agg.size) return null;
  const [id, best] = [...agg.entries()].sort(
    (a, b) => b[1].count - a[1].count || b[1].latest.localeCompare(a[1].latest),
  )[0]!;
  return { id, name: best.name };
}

/** `YYYY-MM` of a Bangkok date string — the month "this month" means, resolved server-side. */
export const monthOf = (date: string) => date.slice(0, 7);

/**
 * Is this timestamp inside the given `YYYY-MM`, **in Bangkok time**? Accepts a Date or an ISO string.
 *
 * ⚠️ Shifted to UTC+7 before comparing — a row created 01 Aug 02:00 Bangkok is 31 Jul 19:00 UTC, so comparing
 * the raw UTC month would file it under the wrong month for the first 7 hours of every month. Thailand has no
 * DST, so the fixed offset is exact.
 */
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
export function inMonth(when: Date | string | null | undefined, month: string): boolean {
  if (!when) return false;
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return false;
  return new Date(d.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 7) === month;
}
