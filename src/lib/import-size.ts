// SPEC-068 / TASK-213 — is this import's size something the system can actually run?
//
// 🔴 The defect this replaces: the form accepted any size 1–100 while leave quota and the max-week ceiling were
// hand-typed tables that knew only 4/6/10. An off-card size reached the engine and **crashed with a 500** —
// `เกิดข้อผิดพลาดภายในระบบ` on the one door the customer's existing families walk through. The intent ("an
// off-card size is importable on purpose") was right and the implementation could not deliver it.
//
// The rule, in one place: **4/6/10 is enough on its own; any other size needs its leave quota stated.** Then
// `maxWeek = size + quota` answers for it like any other course, and nothing falls through a table.
//
// Pure — the service throws, this decides.

import { LEAVE_QUOTA_BY_SIZE } from "./leave";

export interface SizeDecision {
  ok: boolean;
  /** The quota to store: `null` for a card size (derive it), the stated number for an off-card one. */
  leaveQuota: number | null;
  /** Thai, user-facing. A rejected size must read as a sentence a staff member can act on — never a 500. */
  problem?: string;
}

export function decideImportSize(size: number, quota?: number | null): SizeDecision {
  if (!Number.isInteger(size) || size < 1) {
    return { ok: false, leaveQuota: null, problem: "จำนวนคาบต้องเป็นจำนวนเต็มบวก" };
  }
  const onCard = LEAVE_QUOTA_BY_SIZE[size] !== undefined;

  if (onCard) {
    // A stated quota on a card size is allowed but must not silently contradict the card: if someone types a
    // different number for a 10-session course, that is either a mistake or a special agreement, and the two
    // need different handling. Same number ⇒ nothing to store.
    if (quota != null && quota !== LEAVE_QUOTA_BY_SIZE[size]) {
      return { ok: true, leaveQuota: quota };
    }
    return { ok: true, leaveQuota: null };
  }

  if (quota == null) {
    return {
      ok: false,
      leaveQuota: null,
      problem:
        `คอร์ส ${size} คาบไม่มีในราคามาตรฐาน — ต้องระบุจำนวนครั้งที่ลาได้ด้วย ` +
        `(เช่น 4 คาบ ลาได้ 1 ครั้ง, 6 คาบ ลาได้ 2 ครั้ง, 10 คาบ ลาได้ 3 ครั้ง)`,
    };
  }
  if (!Number.isInteger(quota) || quota < 0) {
    return { ok: false, leaveQuota: null, problem: "จำนวนครั้งที่ลาได้ต้องเป็นจำนวนเต็ม 0 ขึ้นไป" };
  }
  return { ok: true, leaveQuota: quota };
}
