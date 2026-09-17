// SPEC-031 / TASK-108 (REQ-028) — record an equipment rental as revenue. No new money mechanism: a rental is a
// `recordSale` of one of the four rental codes (`quantity = hours`). The one thing different from a booking's sale
// is that the rental post IS the event — there's no other artifact — so a failed post is SURFACED, never a silent 200.

import { ApiException, conflict, notFound, pgErrorCode } from "../lib/http";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { bookingRentals } from "../db/schema";
import { rentalBookingLive, rentalRemarkRequired, toRentalDTO } from "../lib/rental-row";
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

// ───────────── TASK-371 (REQ-091 §9, Deploy A) — a rental as a ROW on a session ─────────────
//
// Three doors on one row: record (unpaid, NO money), paid (the ONE place money moves — through `recordRental`
// above, byte for byte: `hours: 1`, `refId = bookingId`, so the ledger's `rental:<bookingId>:<code>` key is the
// backstop), remove (unpaid only). The rules are pure in `lib/rental-row.ts`.

/** A row's presence for the row's own routes: 404 when the session has none. */
async function rentalRowOf(bookingId: string, exec: any = db) {
  return (await exec.query.bookingRentals.findFirst({ where: (r: any, { eq: e }: any) => e(r.bookingId, bookingId) })) ?? null;
}

export async function recordBookingRental(
  bookingId: string,
  input: { code: string; remark?: string | null },
  actor: string | null,
) {
  const booking = await db.query.bookings.findFirst({ where: (b, { eq: e }) => e(b.id, bookingId) });
  if (!booking) throw notFound("ไม่พบคาบเรียน");
  if (!rentalBookingLive(booking.status)) throw conflict("BOOKING_NOT_LIVE", "คาบนี้ถูกยกเลิกหรือพักอยู่ — เพิ่มค่าเช่าไม่ได้");
  if (rentalRemarkRequired(input.code, input.remark)) {
    throw new ApiException(400, "RENTAL_REMARK_REQUIRED", "กรุณาระบุรายละเอียดอุปกรณ์ (ชุด/คู่/ไซส์)");
  }
  const remark = input.remark?.trim() || null;
  try {
    const [row] = await db
      .insert(bookingRentals)
      .values({ bookingId, code: input.code, remark, createdBy: actor })
      .returning();
    return { rental: toRentalDTO(row) };
  } catch (e) {
    // 🔴 The UNIQUE's 23505 is caught HERE: `onError` renders every 23505 as `409 SLOT_TAKEN` ("the slot is
    // taken") — the wrong sentence for a second rental on one session.
    if (pgErrorCode(e) !== "23505") throw e;
    throw conflict("RENTAL_EXISTS", "คาบนี้มีรายการเช่าอุปกรณ์อยู่แล้ว");
  }
}

export async function payBookingRental(bookingId: string, actor: string | null) {
  const row = await rentalRowOf(bookingId);
  if (!row) throw notFound("คาบนี้ไม่มีรายการเช่าอุปกรณ์");
  // Paid twice ⇒ 200, no second post. (And if this guard were ever bypassed, `recordRental`'s idempotency key
  // makes the second post a `duplicate` — two guards on one boundary.)
  if (row.paidAt) return { rental: toRentalDTO(row) };
  // The ONE place money moves — the existing path, unchanged. A failed post throws 502 RENTAL_NOT_POSTED and
  // leaves the row unpaid: the press is retryable.
  const posted = await recordRental({ code: row.code, hours: 1, refId: bookingId, actor });
  if (posted.status !== "recorded" && posted.status !== "duplicate") {
    throw new ApiException(502, "RENTAL_NOT_POSTED", "บันทึกค่าเช่าอุปกรณ์ไม่สำเร็จ — ยังไม่ได้ลงบัญชี กรุณาลองใหม่");
  }
  const [updated] = await db
    .update(bookingRentals)
    .set({ paidAt: new Date(), paidActor: actor })
    .where(eq(bookingRentals.id, row.id))
    .returning();
  return { rental: toRentalDTO(updated) };
}

export async function removeBookingRental(bookingId: string) {
  const row = await rentalRowOf(bookingId);
  if (!row) throw notFound("คาบนี้ไม่มีรายการเช่าอุปกรณ์");
  if (row.paidAt) throw conflict("RENTAL_PAID", "ชำระแล้ว — ลบไม่ได้ (เงินลงบัญชีแล้ว ให้หลังบ้านปรับ)");
  await db.delete(bookingRentals).where(eq(bookingRentals.id, row.id));
  return { removed: true as const };
}
