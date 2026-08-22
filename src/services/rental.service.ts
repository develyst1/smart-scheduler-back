// SPEC-031 / TASK-108 (REQ-028) — record an equipment rental as revenue. No new money mechanism: a rental is a
// `recordSale` of one of the four rental codes (`quantity = hours`). The one thing different from a booking's sale
// is that the rental post IS the event — there's no other artifact — so a failed post is SURFACED, never a silent 200.

import { ApiException } from "../lib/http";
import { recordSale } from "../lib/sale-post";
import { listPriceMinor, rentalIdBase, rentalIdempotencyKey } from "../lib/sale-items";
import { validateSaleDiscount } from "../lib/discount-plan";

export async function recordRental(input: {
  code: string;
  hours: number;
  refId?: string;
  idempotencyKey?: string;
  /** TASK-160 (REQ-063) — optional discount, validated against the LINE TOTAL (hours × rate). */
  discount?: { kind: "PERCENT" | "BAHT"; value: number; reason: string };
  actor?: string | null;
}) {
  // refId present = session add-on (idempotent on booking+code); else a client-supplied key makes a STANDALONE
  // rental idempotent (AC #4); else mint a fresh id so each un-keyed standalone rental is its own sale.
  const idBase = rentalIdBase(input.refId, input.idempotencyKey) ?? crypto.randomUUID();
  const idempotencyKey = rentalIdempotencyKey(idBase, input.code);

  // 🔴 AC-14 — the rental trap. A rental posts `qty = hours`, so its LINE TOTAL is `hours × rate`. Validating a
  // baht discount against the unit rate would wrongly refuse ฿500 off a 3-hour ฿600 rental. Validated BEFORE
  // the post, so an invalid discount refuses the rental instead of recording one at the wrong price.
  const lineTotalMinor = (listPriceMinor(input.code) ?? 0) * input.hours;
  const discount = validateSaleDiscount(input.discount, lineTotalMinor, input.actor ?? null);

  // ⚠️ Small deliberate change (flagged in the task): a STANDALONE rental used to post with `refId: null`. A
  // discount must carry its sale's refId — that is what makes it net the same sale — so a standalone rental now
  // posts under its own `idBase`, giving it an identity it previously lacked. Session add-ons are unchanged
  // (`input.refId` still wins), and nothing about the money changes.
  const result = await recordSale(input.code, input.hours, {
    refId: input.refId ?? idBase,
    idempotencyKey,
    discount,
  });

  if (!result.ok) {
    // item-missing (seed not re-run) / unknown-code / write error — a real failure staff must see, not swallow.
    throw new ApiException(
      502,
      "RENTAL_NOT_POSTED",
      `บันทึกค่าเช่าอุปกรณ์ไม่สำเร็จ (${result.skipped ?? "error"}) — ยังไม่ได้ลงบัญชี กรุณาลองใหม่หรือแจ้งแอดมิน`,
    );
  }

  return {
    status: result.skipped === "duplicate" ? ("duplicate" as const) : ("recorded" as const),
    code: input.code,
    hours: input.hours,
    refId: input.refId ?? null,
    idempotencyKey,
  };
}
