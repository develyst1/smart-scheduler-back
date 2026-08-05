// SPEC-031 / TASK-108 (REQ-028) — record an equipment rental as revenue. No new money mechanism: a rental is a
// `recordSale` of one of the four rental codes (`quantity = hours`). The one thing different from a booking's sale
// is that the rental post IS the event — there's no other artifact — so a failed post is SURFACED, never a silent 200.

import { ApiException } from "../lib/http";
import { recordSale } from "../lib/sale-post";
import { rentalIdBase, rentalIdempotencyKey } from "../lib/sale-items";

export async function recordRental(input: {
  code: string;
  hours: number;
  refId?: string;
  idempotencyKey?: string;
}) {
  // refId present = session add-on (idempotent on booking+code); else a client-supplied key makes a STANDALONE
  // rental idempotent (AC #4); else mint a fresh id so each un-keyed standalone rental is its own sale.
  const idBase = rentalIdBase(input.refId, input.idempotencyKey) ?? crypto.randomUUID();
  const idempotencyKey = rentalIdempotencyKey(idBase, input.code);

  const result = await recordSale(input.code, input.hours, { refId: input.refId, idempotencyKey });

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
