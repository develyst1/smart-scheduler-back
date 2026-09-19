// TASK-401 (REQ-095 Stage 3a, SPEC-082) — the PURE rules of a Balance camp. Code lists (never enums), the unit
// arithmetic (one currency: a full day = 2 units, a half = 1 — integers, so credit never becomes 0.5), the credit
// formula, the day-status transitions. No DB, no clock — every rule here is asserted with values.
import { ApiException, conflict } from "./http";

export const CAMP_KINDS = ["FULL", "HALF"] as const;
export const CAMP_PLANS = ["FULL_WEEK", "DAILY"] as const;
export const CAMP_HALVES = ["AM", "PM", "FULL"] as const;
export const CAMP_DAY_STATUSES = ["PLANNED", "ATTENDED", "ABSENT", "CANCELLED"] as const;
export const CAMP_WEEK_STATUSES = ["OPEN", "CLOSED"] as const;
export type CampKind = (typeof CAMP_KINDS)[number];
export type CampPlan = (typeof CAMP_PLANS)[number];
export type CampHalf = (typeof CAMP_HALVES)[number];
export type CampDayStatus = (typeof CAMP_DAY_STATUSES)[number];

/** The owner's "week" is FIVE days (the product); a week CONTAINER may span 1–7 dates. */
export const FULL_WEEK_DAYS = 5;
/** A week container: 1–7 consecutive dates. */
export const MAX_WEEK_DAYS = 7;
/** A DAILY plan: 1–30 days in one sale. */
export const MAX_DAILY_DAYS = 30;

/** Units a DATE costs: a full day 2, a half (AM | PM) 1. */
export const unitsPerDay = (half: CampHalf): number => (half === "FULL" ? 2 : 1);
/** Units a KIND buys per day: FULL 2, HALF 1. */
export const unitsPerKind = (kind: CampKind): number => (kind === "FULL" ? 2 : 1);

/** A package's total units: FULL_WEEK ⇒ 5 days × the kind; DAILY ⇒ `days` × the kind. */
export function packageUnits(kind: CampKind, plan: CampPlan, days?: number | null): number {
  if (plan === "FULL_WEEK") return FULL_WEEK_DAYS * unitsPerKind(kind);
  if (!days || !Number.isInteger(days) || days < 1 || days > MAX_DAILY_DAYS) throw new ApiException(400, "VALIDATION", `แพ็กเกจรายวันต้องระบุจำนวนวัน 1–${MAX_DAILY_DAYS}`);
  return days * unitsPerKind(kind);
}

/** The sale's QUANTITY on the item: a DAILY plan sells `days` of the per-day item; a FULL_WEEK sells one week item. */
export const saleQuantity = (plan: CampPlan, days?: number | null): number => (plan === "FULL_WEEK" ? 1 : days ?? 0);

/** Credit = total − used − planned (PLANNED rows RESERVE their units). */
export const creditOf = (p: { totalUnits: number; usedUnits: number }, plannedUnits: number): number => p.totalUnits - p.usedUnits - plannedUnits;

/** Consumed = the units are spent; released = they go back to credit. ATTENDED and ABSENT both consume (§8: a no-show is charged). */
export const consumes = (status: CampDayStatus): boolean => status === "ATTENDED" || status === "ABSENT";

/**
 * The 3a transitions: from PLANNED to any of the three; between ATTENDED and ABSENT (the staff correcting the same
 * day — both consumed, so no units move); nothing else (an undo to PLANNED is 3b). CANCELLED only BEFORE the day
 * has started (`date <= today` ⇒ refused: the owner's §4.4 — on the day it is ABSENT, consumed).
 */
export function assertDayTransition(from: string, to: CampDayStatus, date: string, today: string): void {
  const ok = (from === "PLANNED" && (to === "ATTENDED" || to === "ABSENT" || to === "CANCELLED")) || (from === "ATTENDED" && to === "ABSENT") || (from === "ABSENT" && to === "ATTENDED");
  if (!ok) throw conflict("CAMP_DAY_TRANSITION", `เปลี่ยนสถานะจาก ${from} เป็น ${to} ไม่ได้`);
  if (to === "CANCELLED" && date <= today) throw conflict("CAMP_DAY_STARTED", "วันแคมป์เริ่มแล้ว — บันทึกขาดแทน");
}

/** The units delta on a package for a transition (positive = consume more). */
export function unitsDelta(from: string, to: CampDayStatus, units: number): number {
  const before = consumes(from as CampDayStatus) ? units : 0;
  const after = consumes(to) ? units : 0;
  return after - before;
}

/** Consecutive dates from start to end inclusive (ISO). Pure. */
export function datesOfWeek(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const d = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  for (let i = 0; i <= MAX_WEEK_DAYS && d <= end; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
