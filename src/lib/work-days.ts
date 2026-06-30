/** Weekday index: 0=Sun … 6=Sat (matches `weekdayOf()` / JS `Date#getDay()`). */

export const ALL_WORK_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type WorkDay = (typeof ALL_WORK_DAYS)[number];

export const WEEKEND_DAYS: WorkDay[] = [6, 0];
export const WEEKDAY_DAYS: WorkDay[] = [1, 2, 3, 4, 5];

const THAI_SHORT = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"] as const;

export function teacherWorksOnDay(workDays: readonly number[] | null | undefined, weekday: number): boolean {
  if (!workDays?.length) return true;
  return workDays.includes(weekday);
}

/** Human label for admin UI — e.g. "เสาร์, อาทิตย์" or "ทุกวัน". */
export function formatWorkDaysLabel(workDays: readonly number[]): string {
  if (!workDays.length || workDays.length === 7) return "ทุกวัน";
  const sorted = [...new Set(workDays)].sort((a, b) => {
    const order = (d: number) => (d === 0 ? 7 : d);
    return order(a) - order(b);
  });
  if (
    sorted.length === WEEKDAY_DAYS.length &&
    WEEKDAY_DAYS.every((d) => sorted.includes(d))
  ) {
    return "จ–ศ (วันธรรมดา)";
  }
  if (
    sorted.length === WEEKEND_DAYS.length &&
    WEEKEND_DAYS.every((d) => sorted.includes(d))
  ) {
    return "เสาร์–อาทิตย์";
  }
  return sorted.map((d) => THAI_SHORT[d] ?? String(d)).join(", ");
}
