// 🔻 TASK-961 (REQ-5014 option A, SPEC-106 §2) — change the ACTIVITY (subject) of a course's REMAINING classes, or of one 1 HR / 1st Trial. THE PURE PLANNER: which rows change, the prices, the difference, and the refusals as CODES.
// No I/O: `services/scheduler.service.ts` (`runCourseActivityChange` / `runBookingActivityChange`) reads the rows + the card, calls this, and writes in ONE transaction. Modelled on `course-teacher-time-change.ts`.
// 🚫 It invents no rule: the coach-eligibility check is whatever create/move do today (the service cites it); the price is the CARD's list price (`sale-items.ts`) or the one price the admin typed when the card has none.
import { COURSE_LIVE_STATUSES } from "./course-plan";

export const MANUAL_PRICE_MIN_BAHT = 1;
export const MANUAL_PRICE_MAX_BAHT = 100000;

export interface ActivityRow { id: string; date: string; startTime: string; status: string; teacherId: string; groupId?: string | null; bookingType?: string | null }
export interface ActivityRefusal { refused: true; status: 400 | 409; code: ActivityRefusalCode; message: string }
export type ActivityRefusalCode = "SAME_ACTIVITY" | "MANUAL_PRICE_NOT_ALLOWED" | "MANUAL_PRICE_REQUIRED" | "MANUAL_PRICE_RANGE" | "NO_REMAINING_CLASSES" | "GROUP_COURSE" | "OLD_PRICE_NOT_ON_CARD";

/** The Thai words (no English in a staff-facing refusal; the neighbouring course acts speak Thai). */
export const ACTIVITY_REFUSALS: Record<ActivityRefusalCode, { status: 400 | 409; message: string }> = {
  SAME_ACTIVITY: { status: 400, message: "เลือกกิจกรรมเดิมไม่ได้ — กรุณาเลือกกิจกรรมอื่น" },
  MANUAL_PRICE_NOT_ALLOWED: { status: 400, message: "กิจกรรมนี้มีราคาในรายการราคาแล้ว — ไม่ต้องพิมพ์ราคาเอง" },
  MANUAL_PRICE_REQUIRED: { status: 400, message: "กิจกรรมนี้ยังไม่มีราคาในรายการราคา — กรุณาพิมพ์ราคาเอง" },
  MANUAL_PRICE_RANGE: { status: 400, message: `ราคาที่พิมพ์เองต้องเป็นจำนวนเต็มบาท ${MANUAL_PRICE_MIN_BAHT}–${MANUAL_PRICE_MAX_BAHT.toLocaleString("en-US")}` },
  NO_REMAINING_CLASSES: { status: 409, message: "ไม่มีคาบที่เหลือตั้งแต่วันนี้เป็นต้นไป — ไม่มีอะไรให้เปลี่ยน" },
  GROUP_COURSE: { status: 409, message: "คอร์สนี้มีคาบกลุ่ม/คู่ — เปลี่ยนกิจกรรมของคาบกลุ่มไม่ได้" },
  OLD_PRICE_NOT_ON_CARD: { status: 409, message: "กิจกรรมเดิมไม่มีราคาในรายการราคา — คำนวณส่วนต่างไม่ได้" },
};
const refuse = (code: ActivityRefusalCode): ActivityRefusal => ({ refused: true, ...ACTIVITY_REFUSALS[code], code });
export const isActivityRefusal = (x: unknown): x is ActivityRefusal => !!x && typeof x === "object" && (x as ActivityRefusal).refused === true;

const LIVE = new Set<string>(COURSE_LIVE_STATUSES);

/** Round a satang amount to a WHOLE baht (100 satang), half up — the difference is shown and recorded in whole baht. */
export const roundToBaht = (minor: number): number => Math.round(minor / 100) * 100;

/** `max(0, round_to_whole_baht((new − old) × remaining ÷ size))` — her example: 100 → 120 (10 000 → 12 000 satang), 10 classes, 4 left ⇒ 800 satang (8 ฿). A cheaper activity is 0: no refund. */
export function differenceMinor(oldMinor: number, newMinor: number, remaining: number, size: number): number {
  return Math.max(0, roundToBaht(((newMinor - oldMinor) * remaining) / size));
}

/** A typed price is an integer number of baht in 1..100 000. */
export const isValidManualBaht = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= MANUAL_PRICE_MIN_BAHT && n <= MANUAL_PRICE_MAX_BAHT;

export interface PricingInput {
  /** card list price (satang) for the OLD group × size; `undefined` = not on the card */
  oldCardMinor: number | undefined;
  /** card list price (satang) for the NEW group × size; `undefined` = not on the card */
  newCardMinor: number | undefined;
  manualPriceBaht?: number | undefined;
  remaining: number;
  size: number;
  /** the act (not the preview) needs a price when the card has none */
  isAct: boolean;
  /** a 1st Trial is one flat price both sides: the difference is always 0 */
  flat?: boolean;
}
export interface Pricing { oldPriceMinor: number; newPriceMinor: number | null; priceSource: "CARD" | "MANUAL" | null; differenceMinor: number | null }

/** The price rules (SPEC §2.1 table): a typed price is refused when the card has one, required (on the ACT) when it has none, and range-checked. A preview that still needs the price answers `null`s instead of refusing. */
export function priceActivityChange(p: PricingInput): Pricing | ActivityRefusal {
  if (p.oldCardMinor === undefined || p.oldCardMinor <= 0) return refuse("OLD_PRICE_NOT_ON_CARD");
  const typed = p.manualPriceBaht;
  if (typed !== undefined && !isValidManualBaht(typed)) return refuse("MANUAL_PRICE_RANGE");
  const hasCard = p.newCardMinor !== undefined && p.newCardMinor > 0;
  if (hasCard && typed !== undefined) return refuse("MANUAL_PRICE_NOT_ALLOWED");
  if (hasCard) {
    const n = p.newCardMinor!;
    return { oldPriceMinor: p.oldCardMinor, newPriceMinor: n, priceSource: "CARD", differenceMinor: p.flat ? 0 : differenceMinor(p.oldCardMinor, n, p.remaining, p.size) };
  }
  if (typed === undefined) return p.isAct ? refuse("MANUAL_PRICE_REQUIRED") : { oldPriceMinor: p.oldCardMinor, newPriceMinor: null, priceSource: null, differenceMinor: null };
  const n = typed * 100;
  return { oldPriceMinor: p.oldCardMinor, newPriceMinor: n, priceSource: "MANUAL", differenceMinor: p.flat ? 0 : differenceMinor(p.oldCardMinor, n, p.remaining, p.size) };
}

export interface CourseActivityPlan { rows: ActivityRow[]; remaining: number; firstDate: string; lastDate: string; teacherChanged: boolean }

/**
 * The course's REMAINING classes: the live ones (`COURSE_LIVE_STATUSES`, the same rule as the end / change-teacher-time acts) dated today or later; an attended / cancelled / leave row, or one dated before today, is NEVER touched. Refusals, in
 * this order: SAME_ACTIVITY · NO_REMAINING_CLASSES · GROUP_COURSE (any remaining row sits in a group class: its activity is the group's).
 */
export function planCourseActivityChange(
  rows: readonly ActivityRow[],
  input: { currentSubjectId: string | null; subjectId: string; teacherId?: string },
  today: string,
): CourseActivityPlan | ActivityRefusal {
  if (input.currentSubjectId === input.subjectId) return refuse("SAME_ACTIVITY");
  const remaining = rows.filter((r) => LIVE.has(r.status) && r.date >= today).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  if (!remaining.length) return refuse("NO_REMAINING_CLASSES");
  if (remaining.some((r) => r.groupId)) return refuse("GROUP_COURSE");
  return {
    rows: remaining,
    remaining: remaining.length,
    firstDate: remaining[0]!.date,
    lastDate: remaining[remaining.length - 1]!.date,
    teacherChanged: !!input.teacherId && remaining.some((r) => r.teacherId !== input.teacherId),
  };
}
