// TASK-969 (REQ-5016 F1, SPEC-109) — a course's WEEKLY PATTERN of hour-slots, PURE. No I/O here: the callers inject what "free" means, so the preview, the create and the make-up search share ONE placement rule.
//
//   · a pattern = 2…21 slots `{ weekday 0–6, startTime HH:MM, teacherId }`, unique by (weekday, startTime); order = the weekday counted from the COURSE'S START weekday, then the time;
//   · a course week k = `[startDate + 7(k−1), startDate + 7k − 1]` — the same week as `absentWeeks` and the `size + quota` window;
//   · a course with fewer than 2 slots is a ONE-slot course and never reaches this module (AC7: today's code paths, byte for byte).
import { addDays } from "./time";
import { weekdayOf } from "./recurring";

export type Slot = { weekday: number; startTime: string; teacherId: string };
export type PatternRow = { date: string; startTime: string; teacherId: string; week: number; absent: boolean };

export const MIN_PATTERN_SLOTS = 2;
export const MAX_PATTERN_SLOTS = 21; // SPEC-109 §7 Q3 — a guard, [SA-decided]
export const PATTERN_SEARCH_WEEKS = 26; // SPEC-109 §3.2 — the make-up scans up to 26 weeks × the slots

/** The ONE predicate: is this a pattern (2+ slots)? Everything that branches on "pattern course" asks this and nothing else. */
export const isPattern = (slots: ReadonlyArray<unknown> | null | undefined): boolean => (slots?.length ?? 0) >= MIN_PATTERN_SLOTS;

/** `HH:MM[:SS]` → `HH:MM`, so a slot read from the DB and one sent by the screen compare equal. */
export const hhmmOf = (t: string): string => t.slice(0, 5);

/** Offset of a weekday from the course's start weekday: 0 = the start weekday itself … 6. */
const offsetFrom = (startWeekday: number, weekday: number): number => (weekday - startWeekday + 7) % 7;

/** The slots in PATTERN ORDER for a course starting on `startDate`: by weekday counted from the start weekday, then by time. Pure; does not mutate. */
export function orderPattern<T extends { weekday: number; startTime: string }>(startDate: string, slots: readonly T[]): T[] {
  const w0 = weekdayOf(startDate);
  return [...slots].sort((a, b) => offsetFrom(w0, a.weekday) - offsetFrom(w0, b.weekday) || hhmmOf(a.startTime).localeCompare(hhmmOf(b.startTime)));
}

/** 1-based course week of `date` for a course starting `startDate` (a date before the start is week 1's lower bound: 0 → clamped to 1). */
export function courseWeekOf(startDate: string, date: string): number {
  const days = Math.round((Date.parse(date) - Date.parse(startDate)) / 86_400_000);
  return Math.max(1, Math.floor(days / 7) + 1);
}

/** The date of the `slot` occurrence in course week `week` (1-based). */
export function slotDateInWeek(startDate: string, slot: { weekday: number }, week: number): string {
  return addDays(startDate, 7 * (week - 1) + offsetFrom(weekdayOf(startDate), slot.weekday));
}

/**
 * The shape problems of a pattern, in words for the validator (`null` = fine): 2…21 slots (a ONE-slot result is the CHANGE-pattern's, which allows 1), unique (weekday, startTime), weekday 0–6, a half-hour start.
 * `min` is 2 at sale and 1 for a mid-course change (a 1-slot result deletes the slots and sets the course's own weekday / start).
 */
export function patternProblem(slots: ReadonlyArray<Slot>, min: number = MIN_PATTERN_SLOTS): string | null {
  if (slots.length < min || slots.length > MAX_PATTERN_SLOTS) return `ตารางประจำสัปดาห์ต้องมี ${min}–${MAX_PATTERN_SLOTS} คาบ`; // 📋 ENGINEER WORDING — a line the pattern editor makes unreachable
  const seen = new Set<string>();
  for (const s of slots) {
    if (!(s.weekday >= 0 && s.weekday <= 6) || !/^\d{2}:\d{2}$/.test(hhmmOf(s.startTime))) return "คาบในตารางไม่ถูกต้อง";
    if (!/:(00|30)$/.test(hhmmOf(s.startTime))) return "เวลาต้องเป็นต้นชั่วโมงหรือครึ่งชั่วโมง";
    const k = `${s.weekday}|${hhmmOf(s.startTime)}`;
    if (seen.has(k)) return "มีคาบซ้ำในตาราง (วันและเวลาเดียวกัน)";
    seen.add(k);
  }
  return null;
}

/**
 * EXPAND a pattern (SPEC-109 §3.1): walk the weeks from `startDate`, and in each week the slots in pattern order; skip a slot dated before `startDate`; stop at `size` rows.
 * `absentWeeks` are COURSE weeks (1-based): every row in such a week is born a planned absence.
 * 🔑 SPEC-109 §8b (the seam to the mid-course change / resume): an optional 5th `fromDate` (default `startDate` = every existing caller unchanged) — rows dated BEFORE it are skipped, `size` is the number of rows to produce FROM it, the week bound
 * becomes `courseWeekOf(startDate, fromDate) + size + 1`, and `week` stays the COURSE week counted from `startDate`.
 */
export function expandPattern(startDate: string, slots: readonly Slot[], size: number, absentWeeks: ReadonlySet<number> = new Set(), fromDate: string = startDate): PatternRow[] {
  const ordered = orderPattern(startDate, slots);
  const out: PatternRow[] = [];
  const firstWeek = courseWeekOf(startDate, fromDate);
  for (let week = firstWeek; out.length < size && week <= firstWeek + size + 1; week++) {
    for (const s of ordered) {
      if (out.length >= size) break;
      const date = slotDateInWeek(startDate, s, week);
      if (date < startDate || date < fromDate) continue;
      out.push({ date, startTime: hhmmOf(s.startTime), teacherId: s.teacherId, week, absent: absentWeeks.has(week) });
    }
  }
  return out;
}

/** Every occurrence of the pattern after `(afterDate, afterTime)` in pattern order, for up to `weeks` course weeks past the week of `afterDate` — lazily, so the caller stops at the first free one. */
export function* occurrencesAfter(startDate: string, slots: readonly Slot[], afterDate: string, afterTime: string, weeks: number = PATTERN_SEARCH_WEEKS): Generator<PatternRow> {
  const ordered = orderPattern(startDate, slots);
  const w0 = courseWeekOf(startDate, afterDate);
  for (let week = w0; week < w0 + weeks + 1; week++) {
    for (const s of ordered) {
      const date = slotDateInWeek(startDate, s, week);
      const t = hhmmOf(s.startTime);
      if (date < afterDate || (date === afterDate && t <= hhmmOf(afterTime))) continue;
      yield { date, startTime: t, teacherId: s.teacherId, week, absent: false };
    }
  }
}

/**
 * The NEXT FREE SLOT in pattern order after the last planned row (SPEC-109 §3.2). `isFree` is injected — the slot is not held, the coach is not on leave at that hour, the day is not closed, the hour is inside the coach's hours.
 * Scans up to `weeks` × the slots; `null` when nothing is free ⇒ the caller falls back to the existing exhausted-search rule (`searchExhausted`, the admin told) — a make-up is NEVER refused.
 */
export async function nextFreeSlot(
  startDate: string,
  slots: readonly Slot[],
  after: { date: string; startTime: string },
  isFree: (row: PatternRow) => boolean | Promise<boolean>,
  weeks: number = PATTERN_SEARCH_WEEKS,
): Promise<PatternRow | null> {
  for (const occ of occurrencesAfter(startDate, slots, after.date, after.startTime, weeks)) if (await isFree(occ)) return occ;
  return null;
}

