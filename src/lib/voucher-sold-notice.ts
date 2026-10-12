// 🔻 TASK-730 (D1, Khwan's row 45; 📋 DRAFT — Q5 pending: the expiry format and the Remark source) — the FAMILY is told, once, that a voucher was SOLD.
// Called by `createVoucher` after the commit and by nothing else: `importVoucher` is historical data, not a sale, and sends nothing.
// A failed notice costs the NOTICE, never the sale (the outbox's rule). No linked family ⇒ nothing is sent, as for every family notice.
import { db } from "../db";
import { studentNamesOf } from "../db/mappers";
import { householdLineUserIds } from "./family-link";
import { enqueueLine } from "./line";
import { VOUCHER_VALIDITY_MONTHS } from "./voucher"; // 🔻 TASK-730 rework — the table that decides the real expiry also decides what the sale says

export async function notifyVoucherSold(
  voucher: { id: string; totalHours: number; student: { id: string; name: string; nickname?: string | null } },
  exec: any = db,
): Promise<void> {
  try {
    const payload = {
      kind: "voucher_sold_parent",
      studentName: studentNamesOf({ student: voucher.student }) ?? "", // the ONE name rule
      hours: voucher.totalHours,
      // 🔻 Khwan's Q5 answer: the expiry shows MONTHS ("3 Months"). Truer at the sale too: validity counts from the FIRST BOOKING, so a date would be provisional.
      months: VOUCHER_VALIDITY_MONTHS[voucher.totalHours],
    };
    for (const lineUserId of await householdLineUserIds(exec, [voucher.student.id])) {
      // one key per voucher and account: a retry of the same sale can never send twice (the key is used on the default connection, not inside a tx)
      await enqueueLine({ recipientType: "parent", recipientLineUserId: lineUserId, payload, idempotencyKey: `voucher-sold:${voucher.id}:${lineUserId}` }, exec);
    }
  } catch (e) {
    console.error("[voucher-sold] the family notice failed — the sale stands:", e instanceof Error ? e.message : e);
  }
}
