// TASK-492 (SPEC-094) — the admin UNDO's rules, PURE where they can be (each pinned by value); the transaction that applies
// them is `services/undo.service.ts`. The contract and Sober's ruling are in the TASK file — the short version:
//  · a SICK_LEAVE row ⇒ back to CONFIRMED, its quota refunded ONLY if it took quota (`leaveChargeOf`), its make-up removed
//    (`makeupDecision`), the expiry restored only when exactly recoverable (`expiryDecision`);
//  · an ATTENDED row from a PARENT's check-in ⇒ back to CONFIRMED, the unit returned, silently; the day-end then leaves it
//    alone (`notUndoneAttendance`, TASK-497). A STAFF attend is out (TASK-258 is its own, separate finding);
//  · a SETTLED day ⇒ refused, hard (owner, Q1). Settled = before today, OR the day-end ran for that date.
import { sql } from "drizzle-orm";
import { bookingUndos, bookings } from "../db/schema";
import { conflict } from "./http";
import type { CheckinChannel } from "./checkin-channel";

/** The channels a PARENT's check-in arrives by — the only ATTENDED rows this Undo reverses. */
export const UNDO_CHECKIN_CHANNELS: readonly CheckinChannel[] = ["checkin-qr", "line", "shopfront-qr"];

export type UndoKind = "leave" | "checkin";

/** Refusals — each names what it refused, in the admin's language (the codebase's Thai). */
export const UNDO_NOT_UNDOABLE = (status: string) => conflict("UNDO_NOT_UNDOABLE", `คาบนี้ย้อนกลับไม่ได้ — สถานะปัจจุบันคือ ${status} (ย้อนกลับได้เฉพาะการลา หรือการเช็คอินของผู้ปกครอง)`);
export const UNDO_STAFF_ATTEND = () => conflict("UNDO_STAFF_ATTEND", "คาบนี้เจ้าหน้าที่เป็นผู้บันทึกการเข้าเรียน — การย้อนกลับใช้ได้กับการเช็คอินของผู้ปกครองเท่านั้น");
export const UNDO_DAY_SETTLED = (date: string) => conflict("UNDO_DAY_SETTLED", `ปิดวันของวันที่ ${date} แล้ว — ย้อนกลับไม่ได้`);
export const UNDO_LEAVE_CHARGE_UNKNOWN = () => conflict("UNDO_LEAVE_CHARGE_UNKNOWN", "ระบบไม่ทราบว่าการลานี้ใช้โควตาลาหรือไม่ (ลาก่อนมีการบันทึก) — กรุณาแก้ไขด้วยตนเอง");
export const UNDO_ALREADY_CHANGED = () => conflict("UNDO_ALREADY_CHANGED", "คาบนี้ถูกเปลี่ยนสถานะไปแล้ว — ไม่มีอะไรถูกย้อนกลับ");
export const UNDO_SLOT_TAKEN = (hour: string, holder: string) => conflict("UNDO_SLOT_TAKEN", `ย้อนกลับไม่ได้ — ช่วงเวลา ${hour} ของครูมีคาบของ ${holder} อยู่แล้ว`);
export const UNDO_PLAN_WOULD_CHANGE = () => conflict("UNDO_PLAN_WOULD_CHANGE", "ย้อนกลับแล้วแผนคอร์สจะเปลี่ยน (คาบขยายของการลาอื่นจะถูกยกเลิก/เพิ่ม) — กรุณาแก้ไขด้วยตนเอง");

/**
 * Which Undo this row is — or the refusal. SICK_LEAVE ⇒ a leave; ATTENDED by a parent's check-in ⇒ a check-in; ATTENDED by
 * staff ⇒ refused (Sober: out of this task — TASK-258's `SICK_LEAVE` undo is its own finding); anything else ⇒ refused.
 */
export function undoKindOf(row: { status: string; checkinChannel?: string | null }): UndoKind {
  if (row.status === "SICK_LEAVE") return "leave";
  if (row.status === "ATTENDED") {
    if (row.checkinChannel && (UNDO_CHECKIN_CHANNELS as readonly string[]).includes(row.checkinChannel)) return "checkin";
    if (row.checkinChannel === "staff") throw UNDO_STAFF_ATTEND();
  }
  throw UNDO_NOT_UNDOABLE(row.status);
}

/**
 * 🔴 Did this leave take quota? A RECORDED answer wins (`leave_charged`, 0058). A legacy row (NULL) is inferred ONLY where
 * certain: no course ⇒ no quota exists; declared at creation ⇒ free (owner decision B); a make-up linked to it ⇒ charged (both
 * doors create one exactly when they charge). Anything else ⇒ "unknown" ⇒ REFUSED — an escalated refusal is cheap, a wrong
 * refund is invisible.
 */
export function leaveChargeOf(row: { leaveCharged?: boolean | null; courseId?: string | null; plannedAtCreation?: boolean | null }, hasLinkedMakeup: boolean): "charged" | "free" | "unknown" {
  if (row.leaveCharged === true) return "charged";
  if (row.leaveCharged === false) return "free";
  if (!row.courseId) return "free";
  if (row.plannedAtCreation) return "free";
  if (hasLinkedMakeup) return "charged";
  return "unknown";
}

export type LinkedRow = { id: string; status: string; date: string };
export type MakeupDecision = { action: "none" } | { action: "cancel"; makeup: LinkedRow };

/**
 * The make-up this leave created — the row whose `extendedFromId` IS the leave (never "the newest EXTENDED": the reconcile's
 * own trim would cancel ANOTHER leave's make-up). Passed the linked rows that are not CANCELLED, and whether a date is settled.
 */
export function makeupDecision(linked: LinkedRow[], isSettled: (date: string) => boolean): MakeupDecision {
  if (!linked.length) return { action: "none" };
  if (linked.length > 1) throw conflict("UNDO_MAKEUP_AMBIGUOUS", `การลานี้มีคาบขยายมากกว่าหนึ่งคาบ (${linked.map((m) => m.date).join(", ")}) — กรุณาแก้ไขด้วยตนเอง`);
  const m = linked[0]!;
  if (m.status === "ATTENDED" || m.status === "NO_SHOW") throw conflict("UNDO_MAKEUP_TAUGHT", `คาบขยายของการลานี้ (${m.date}) เรียนไปแล้ว — ย้อนกลับไม่ได้ กรุณาแก้ไขด้วยตนเอง`);
  if (m.status === "SICK_LEAVE") throw conflict("UNDO_MAKEUP_CHAIN", `คาบขยายของการลานี้ (${m.date}) ถูกแจ้งลาต่อ — ย้อนกลับไม่ได้ กรุณาแก้ไขด้วยตนเอง`);
  if (m.status !== "EXTENDED" && m.status !== "CONFIRMED" && m.status !== "PENDING") throw conflict("UNDO_MAKEUP_STATE", `คาบขยายของการลานี้ (${m.date}) มีสถานะ ${m.status} — ย้อนกลับไม่ได้`);
  if (isSettled(m.date)) throw conflict("UNDO_MAKEUP_SETTLED", `คาบขยายของการลานี้ (${m.date}) อยู่ในวันที่ปิดแล้ว — ย้อนกลับไม่ได้`);
  return { action: "cancel", makeup: m };
}

export type ExpiryChangeRow = { fromDate: string; toDate: string; actor: string | null };
export type ExpiryDecision = { action: "keep" } | { action: "restore"; from: string; to: string };

/**
 * 🔑 The expiry: restored ONLY when it can be computed back exactly, else STOP (a silently wrong expiry ends a course early).
 *  · the make-up does not sit ON the expiry ⇒ it does not hold it ⇒ keep;
 *  · another live row of the course sits on/after it ⇒ still needed ⇒ keep;
 *  · else restore to the latest change's `from` — only if that change is the SYSTEM's stretch (actor null) TO this date and
 *    every remaining row fits under its `from`. Anything else ⇒ refused, naming why.
 */
export function expiryDecision(input: { expiry: string; makeupDate: string; otherDates: string[]; latest: ExpiryChangeRow | null }): ExpiryDecision {
  const { expiry, makeupDate, otherDates, latest } = input;
  if (makeupDate !== expiry) return { action: "keep" };
  if (otherDates.some((d) => d >= makeupDate)) return { action: "keep" };
  const why = !latest
    ? "กำหนดตั้งแต่เปิดคอร์ส (ไม่มีบันทึกการเลื่อน)"
    : latest.toDate !== expiry
      ? `บันทึกการเลื่อนล่าสุดไม่ใช่ของคาบขยายนี้ (${latest.fromDate} → ${latest.toDate})`
      : latest.actor != null
        ? `เลื่อนโดย ${latest.actor}`
        : otherDates.some((d) => d > latest.fromDate)
          ? `มีคาบหลังวันที่ ${latest.fromDate}`
          : null;
  if (why) throw conflict("UNDO_EXPIRY_UNRECOVERABLE", `คำนวณวันหมดอายุเดิมกลับไม่ได้ (ปัจจุบัน ${expiry}: ${why}) — ย้อนกลับไม่ได้ กรุณาแก้ไขด้วยตนเอง`);
  return { action: "restore", from: expiry, to: latest!.fromDate };
}

/**
 * 🔴 The day-end's exclusion (Sober ❓2): a session whose ATTENDANCE an admin UNDID is not auto-attended — otherwise the Undo is
 * re-done at the cut, the unit consumed again and the deduction message sent. Read from the append-only record, so it holds
 * for as long as the row stays CONFIRMED; a later real check-in makes it ATTENDED and the day-end never looks at it again.
 * 🔻 TASK-497 — renamed from `notUndoneCheckin` and WIDENED to both attendance kinds: a parent's check-in undone (`checkin`) and
 * a staff / day-end mark undone (`attendance`, 0059). A `leave` Undo is not here: a leave Undo's row was never attended.
 */
export const notUndoneAttendance = () =>
  sql`not exists (select 1 from ${bookingUndos} where ${bookingUndos.bookingId} = ${bookings.id} and ${bookingUndos.kind} in ('checkin', 'attendance'))`;

/**
 * 🔑 TASK-497 — the TRUE kind of an undone attendance: a PARENT's check-in (one of `UNDO_CHECKIN_CHANNELS`) is `checkin`;
 * anything else — a staff mark, the day-end's, a legacy row with no channel — is `attendance`. Never `checkin` for something
 * that was not a check-in (Sober's (ii): the next reader of `booking_undos` must learn what actually happened).
 */
export const attendanceUndoKind = (row: { checkinChannel?: string | null }): "checkin" | "attendance" =>
  row.checkinChannel && (UNDO_CHECKIN_CHANNELS as readonly string[]).includes(row.checkinChannel) ? "checkin" : "attendance";
