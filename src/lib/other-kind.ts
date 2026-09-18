// TASK-394 (REQ-095 Stage 1, SPEC-080) — the KINDS of an อื่นๆ (OTHER) schedule. A code list, never a Postgres enum:
// an enum label add cannot share a transaction with its first use (0029's split-run lesson); a text column with a
// closed list here costs nothing and can grow (DUO/Group, Camp are their OWN objects — SPEC-080 §1 — not kinds).
import { ApiException } from "./http";

export const OTHER_KINDS = ["ECA", "FREE", "KOL"] as const;
export type OtherKind = (typeof OTHER_KINDS)[number];
export const isOtherKind = (k: unknown): k is OtherKind => typeof k === "string" && (OTHER_KINDS as readonly string[]).includes(k);

// TASK-397 (REQ-095 Stage 2a) — the kinds of a GROUP row, in the SAME column (`other_kind`). 🔴 `booking_type ⇔ kind`:
// OTHER ⇔ {ECA, FREE, KOL}; GROUP ⇔ {DUO, GROUP} (required); every lesson type ⇔ none. `assertKindForType` refuses
// the cross both ways — a DUO on an OTHER row, an ECA on a GROUP row.
export const GROUP_KINDS = ["DUO", "GROUP"] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];
export const isGroupKind = (k: unknown): k is GroupKind => typeof k === "string" && (GROUP_KINDS as readonly string[]).includes(k);
export function assertKindForType(bookingType: string, kind: string | null | undefined): void {
  if (bookingType === "GROUP") {
    if (!isGroupKind(kind)) throw new ApiException(400, "VALIDATION", `ชนิดกลุ่มต้องเป็น ${GROUP_KINDS.join(" / ")}`);
    return;
  }
  if (bookingType === "OTHER") {
    if (kind != null && !isOtherKind(kind)) throw new ApiException(400, "VALIDATION", `ชนิดรายการอื่นๆ ต้องเป็น ${OTHER_KINDS.join(" / ")}`);
    return;
  }
  if (kind != null) throw new ApiException(400, "VALIDATION", "ฟิลด์นี้ใช้ได้เฉพาะการจองประเภท “อื่นๆ” หรือ “กลุ่ม”");
}

/**
 * The per-teacher rates a caller sends: ONE map keyed by teacher id, for the primary AND the extras. An id that is
 * not on the booking is refused (400) — a rate for nobody is a typo, not a fact. Pure.
 */
export function assertRatesOnBooking(rates: Record<string, number> | undefined, teacherIds: readonly string[]): void {
  if (!rates) return;
  const on = new Set(teacherIds);
  const stray = Object.keys(rates).filter((id) => !on.has(id));
  if (stray.length) throw new ApiException(400, "VALIDATION", `อัตราค่าสอนของครูที่ไม่ได้อยู่ในรายการ: ${stray.join(", ")}`);
}
