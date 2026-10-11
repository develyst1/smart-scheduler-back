// 🔻 TASK-730 (D1, Khwan's row 45; 📋 DRAFT — Q5 pending: the expiry format and the Remark source) — the FAMILY is told, once, that a voucher was SOLD.
// Called by `createVoucher` after the commit and by nothing else: `importVoucher` is historical data, not a sale, and sends nothing.
// A failed notice costs the NOTICE, never the sale (the outbox's rule). No linked family ⇒ nothing is sent, as for every family notice.
import { db } from "../db";
import { studentNamesOf } from "../db/mappers";
import { householdLineUserIds } from "./family-link";
import { enqueueLine } from "./line";

export async function notifyVoucherSold(
  voucher: { id: string; totalHours: number; expiryDate: string; student: { id: string; name: string; nickname?: string | null } },
  exec: any = db,
): Promise<void> {
  try {
    const payload = {
      kind: "voucher_sold_parent",
      studentName: studentNamesOf({ student: voucher.student }) ?? "", // the ONE name rule
      hours: voucher.totalHours,
      expiryDate: voucher.expiryDate,
    };
    for (const lineUserId of await householdLineUserIds(exec, [voucher.student.id])) {
      // one key per voucher and account: a retry of the same sale can never send twice (the key is used on the default connection, not inside a tx)
      await enqueueLine({ recipientType: "parent", recipientLineUserId: lineUserId, payload, idempotencyKey: `voucher-sold:${voucher.id}:${lineUserId}` }, exec);
    }
  } catch (e) {
    console.error("[voucher-sold] the family notice failed — the sale stands:", e instanceof Error ? e.message : e);
  }
}
