// TASK-492 (SPEC-094) — the admin UNDO's rules, PURE where they can be (each pinned by value); the transaction that applies
// them is `services/undo.service.ts`. The contract and Sober's ruling are in the TASK file — the short version:
//  · a SICK_LEAVE row ⇒ back to CONFIRMED, its COUNT given back ONLY if the leave was counted (`leaveChargeOf`), its make-up removed
//    (`makeupDecision`). 🔻 TASK-657 §R (REQ-112): the Undo NEVER touches the expiry — `expiryDecision` and its refusals are GONE (an ordinary
//    leave never added a week; a declared day's week is not returned — the owner's 10-04 ruling; a coach's leave is lifted, not undone);
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
// 🔻 TASK-657 §R (REQ-112) — `UNDO_LEAVE_CHARGE_UNKNOWN` is GONE: it asked "did this leave use quota?", and no leave consumes a quota any more, so the
// question has no subject. Its §T-G sentence (owner-approved 10-04) ships nowhere else — it simply stops being reachable.
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
 * 🔻 TASK-657 §R (REQ-112) — was this leave COUNTED? `leaveUsed` is a plain count now (it gates nothing), so this decides whether the Undo gives
 * ONE count back, and only that. A RECORDED answer wins (`leave_charged`, 0058). A legacy row (NULL): no course ⇒ nothing counted; declared at
 * creation ⇒ free (never counted — owner decision B); anything else ⇒ counted. ⚠️ The old third answer, "unknown" (a pre-0058 row with no make-up
 * to prove it), is GONE with the refusal it fed: it existed because a wrong refund of a QUOTA was invisible and costly; a wrong count is
 * neither — the decrement is floored at 0 — so the common case (a counted leave) is the answer. 🔑 Free days are still NOT refunded: they never
 * incremented the counter, so giving one back would take it from ANOTHER leave.
 */
export function leaveChargeOf(row: { leaveCharged?: boolean | null; courseId?: string | null; plannedAtCreation?: boolean | null }): "charged" | "free" {
  if (row.leaveCharged === true) return "charged";
  if (row.leaveCharged === false) return "free";
  if (!row.courseId) return "free";
  if (row.plannedAtCreation) return "free";
  return "charged";
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
  // 📋 DRAFT (REQ-114 (i), TASK-657 §2 — owner approval pending in @Porter's copy set; marked until @Sober says approved). It NAMES THE STEPS, and the
  // second branch says STOP rather than a path: Khwan's Peeta case — the two-step path removes a leave she meant to keep. Until the one-click
  // chain undo (REQ-114 (iii), NEXT week) ships, the honest instruction for that case is "ask". EN (reading only; refusals are Thai-only): "This leave's
  // make-up ({date}) is itself on leave — it can't be undone in one step. If {date} is coming back too: undo {date}'s leave first, then this one. If the
  // family is really still away on {date}: don't undo yet — tell the system owner."
  if (m.status === "SICK_LEAVE") throw conflict("UNDO_MAKEUP_CHAIN", `คาบขยายของการลานี้ (${m.date}) ถูกแจ้งลาต่อ — ย้อนกลับทีเดียวไม่ได้ · ถ้าวันที่ ${m.date} จะกลับมาเรียนด้วย: ย้อนการลาของวันที่ ${m.date} ก่อน แล้วค่อยย้อนการลานี้ · ถ้าวันที่ ${m.date} ยังลาอยู่จริง: อย่าเพิ่งย้อน ให้แจ้งผู้ดูแลระบบ`);
  if (m.status !== "EXTENDED" && m.status !== "CONFIRMED" && m.status !== "PENDING") throw conflict("UNDO_MAKEUP_STATE", `คาบขยายของการลานี้ (${m.date}) มีสถานะ ${m.status} — ย้อนกลับไม่ได้`);
  if (isSettled(m.date)) throw conflict("UNDO_MAKEUP_SETTLED", `คาบขยายของการลานี้ (${m.date}) อยู่ในวันที่ปิดแล้ว — ย้อนกลับไม่ได้`);
  return { action: "cancel", makeup: m };
}

// 🔻 TASK-657 §R (REQ-112) — `expiryDecision`, `ExpiryDecision`, `ExpiryChangeRow` and `UNDO_EXPIRY_UNRECOVERABLE` (both its sentences) are DELETED. The Undo does
// not move the expiry, so there is nothing to decide and nothing to refuse — which also ends REQ-114 (ii) (the self-block: an Undo recorded its own expiry
// restore with the ADMIN as actor and the NEXT Undo read that as a person's move and refused) BY CONSTRUCTION. Nothing is left to block.

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
