// TASK-401 (REQ-095 Stage 3a, SPEC-082) — the PURE rules of a Balance camp. Code lists (never enums), the unit
// arithmetic (one currency: a full day = 2 units, a half = 1 — integers, so credit never becomes 0.5), the credit
// formula, the day-status transitions. No DB, no clock — every rule here is asserted with values.
import { ApiException, conflict } from "./http";
import { tb } from "./line-i18n";

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
 * The transitions: from PLANNED to any of the three; between ATTENDED and ABSENT (the staff correcting the same
 * day — both consumed, so no units move); the UNDO (3b, TASK-403): ATTENDED | ABSENT → PLANNED (the units go back,
 * no money — a required reason at the boundary); nothing else — a CANCELLED row is final. CANCELLED only BEFORE
 * the day has started (`date <= today` ⇒ refused: the owner's §4.4 — on the day it is ABSENT, consumed).
 */
export function assertDayTransition(from: string, to: CampDayStatus, date: string, today: string): void {
  const ok = (from === "PLANNED" && (to === "ATTENDED" || to === "ABSENT" || to === "CANCELLED")) || (from === "ATTENDED" && to === "ABSENT") || (from === "ABSENT" && to === "ATTENDED") || isUndo(from, to);
  if (!ok) throw conflict("CAMP_DAY_TRANSITION", `เปลี่ยนสถานะจาก ${from} เป็น ${to} ไม่ได้`);
  if (to === "CANCELLED" && date <= today) throw conflict("CAMP_DAY_STARTED", "วันแคมป์เริ่มแล้ว — บันทึกขาดแทน");
}

/** The UNDO (3b): a consumed day back to PLANNED. */
export const isUndo = (from: string, to: string): boolean => to === "PLANNED" && (from === "ATTENDED" || from === "ABSENT");

/** The units delta on a package for a transition (positive = consume more; the undo is negative). */
export function unitsDelta(from: string, to: CampDayStatus, units: number): number {
  const before = consumes(from as CampDayStatus) ? units : 0;
  const after = consumes(to) ? units : 0;
  return after - before;
}

/** `used_units` after a delta — never below zero, whatever the row holds (the check-in-correction floor). */
export const usedAfter = (used: number, delta: number): number => Math.max(0, (used ?? 0) + delta);

/** A camp day's token lives the whole DATE (no start time): 23:59:59 Bangkok of that date. */
export const campTokenExpiry = (date: string): Date => new Date(`${date}T23:59:59+07:00`);

/**
 * The camp SCAN (TASK-403, the public `POST /checkin/camp`): what one scan means for a day row. Pure — the service
 * does the write through `markDay`. `"already"` = ATTENDED (idempotent, nothing written); `"attend"` = PLANNED or
 * ABSENT (the child turned up — the ATTENDED ↔ ABSENT correction through the SAME transition); a CANCELLED row is
 * `409 CAMP_DAY_TRANSITION`; a scan on any other date than the day's is `409 CAMP_DAY_NOT_TODAY` (the token exists
 * from the first QR view, so the wrong day must refuse); an expired token is `410 CAMP_TOKEN_EXPIRED` — the camp's
 * code; the session's page keeps its 400, on purpose.
 */
export function campScanOutcome(day: { status: string; date: string; checkinTokenExpiresAt?: Date | null }, today: string, now: Date): "already" | "attend" {
  if (day.status === "ATTENDED") return "already";
  if (day.status === "CANCELLED") throw conflict("CAMP_DAY_TRANSITION", "วันแคมป์นี้ถูกยกเลิกแล้ว");
  if (day.checkinTokenExpiresAt && day.checkinTokenExpiresAt < now) throw new ApiException(410, "CAMP_TOKEN_EXPIRED", tb("checkin_too_late")); // TASK-479 — the parent's words (the API code is internal and stays)
  if (day.date !== today) throw conflict("CAMP_DAY_NOT_TODAY", `วันแคมป์นี้คือวันที่ ${day.date} — เช็คอินได้เฉพาะวันนั้น`);
  return "attend";
}

// ───────────── TASK-418 (REQ-095 §11) — the camp BLOCK on the grid: the window and the wanted set (pure) ─────────────
/** The owner's default window (§12): one window per day, 10:00–15:00, editable per week. */
export const CAMP_WINDOW_DEFAULT = { start: "10:00", end: "15:00" } as const;
/** The shop's day for a camp window. */
export const CAMP_WINDOW_BOUNDS = { earliest: "06:00", latest: "22:00" } as const;

const hm = (t: string) => t.slice(0, 5);
/** A window is whole hours inside the bounds with start < end. `400` otherwise (the validator's shape check is the wrapper). */
export function assertCampWindow(start: string, end: string): void {
  const s = hm(start), e = hm(end);
  if (!/^\d{2}:00$/.test(s) || !/^\d{2}:00$/.test(e)) throw new ApiException(400, "VALIDATION", "ช่วงเวลาแคมป์ต้องเป็นชั่วโมงเต็ม (เช่น 10:00–15:00)");
  if (s < CAMP_WINDOW_BOUNDS.earliest || e > CAMP_WINDOW_BOUNDS.latest) throw new ApiException(400, "VALIDATION", `ช่วงเวลาแคมป์ต้องอยู่ระหว่าง ${CAMP_WINDOW_BOUNDS.earliest}–${CAMP_WINDOW_BOUNDS.latest}`);
  if (s >= e) throw new ApiException(400, "VALIDATION", "เวลาเริ่มต้องก่อนเวลาสิ้นสุด");
}
/** The hours a window covers: [start, end) in whole hours — `10:00–15:00` ⇒ 10, 11, 12, 13, 14. */
export function windowHours(start: string, end: string): string[] {
  const out: string[] = [];
  for (let h = Number(hm(start).slice(0, 2)); h < Number(hm(end).slice(0, 2)); h++) out.push(`${String(h).padStart(2, "0")}:00`);
  return out;
}
/**
 * The wanted set of a day: every (teacher, hour) — no teacher ⇒ none. Keys `teacherId|HH:MM`.
 *
 * 🔻 TASK-454 (REQ-105 §1) — each coach brings their OWN window now (A 10–12 while B works 13–15), so the set is built
 * per coach instead of "every teacher × one window". Overlap is ALLOWED and needs no special case: two coaches on the
 * same hour are two different keys, and a CAMP row is per coach.
 */
export function wantedCampSlots(coaches: ReadonlyArray<{ teacherId: string; start: string; end: string }>): Set<string> {
  const out = new Set<string>();
  for (const c of coaches) for (const h of windowHours(c.start, c.end)) out.add(`${c.teacherId}|${h}`);
  return out;
}
/** The diff the sync applies: what to insert (wanted − existing) and what to delete (existing − wanted). Pure. */
export function campSlotDiff(wanted: ReadonlySet<string>, existing: ReadonlyMap<string, string>): { insert: string[]; remove: string[] } {
  return { insert: [...wanted].filter((k) => !existing.has(k)).sort(), remove: [...existing.entries()].filter(([k]) => !wanted.has(k)).map(([, id]) => id) };
}
/** The reminder fold (SPEC-085 §3.4): CAMP rows of one (coach, date, day) become ONE row spanning the earliest start to the latest end. Pure. */
export function foldCampRows<T extends { startTime: string; endTime?: string | null; campWeekDayId?: string | null; otherKind?: string | null }>(rows: T[]): T[] {
  const out: T[] = [];
  const folded = new Map<string, T>();
  for (const r of rows) {
    if (r.otherKind !== "CAMP" || !r.campWeekDayId) { out.push(r); continue; }
    const cur = folded.get(r.campWeekDayId);
    if (!cur) { folded.set(r.campWeekDayId, { ...r }); out.push(folded.get(r.campWeekDayId)!); continue; }
    if (hm(r.startTime) < hm(cur.startTime)) cur.startTime = r.startTime;
    if ((r.endTime ?? "") > (cur.endTime ?? "")) cur.endTime = r.endTime;
  }
  return out;
}

/** Consecutive dates from start to end inclusive (ISO). Pure. */
export function datesOfWeek(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const d = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  for (let i = 0; i <= MAX_WEEK_DAYS && d <= end; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
