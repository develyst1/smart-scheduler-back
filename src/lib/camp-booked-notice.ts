// 🔻 TASK-735 (D2, Khwan's row 46; 📋 DRAFT — Q3 pending: the `Program` wording) — the FAMILY is told what is BOOKED for a camp package: when days are booked, again when they change, and
// again when one is cancelled (Khwan Q6: "ส่งใหม่ค่ะ"). ONE function for all three: it reads the package's CURRENT planned days (so the message always says what is true NOW) and sends
// one «CONFIRMED SCHEDULE» per (week, half) group to the student's household. The camp service calls it AFTER its transaction commits; a failed notice costs the notice, never the booking.
// The LAST planned day cancelled ⇒ her layout under the approved cancel title for the day that went (nothing is left to confirm).
//
// 🔴 TEST-099 F1 (Tanya) — "the family must hear about a RETURN to an earlier set of days". The send-once key used to be the STATE itself, so booked 09–10 → added 11 → cancelled 11 (back to
// 09–10) reused msg 1's key and the outbox dropped it: the family kept holding "09–11", FALSE. The fix compares with the LAST message only, never with all history:
//   · the last camp message of this package to this recipient (newest first) carries the combined state it announced (`batch`); the SAME state ⇒ nothing changed for the family ⇒ skip;
//   · otherwise the key is CHAINED on that last message — `camp:{package}:{recipient}:after:{lastOutboxId|none}:{batch}:{group}` — so two triggers of one change (a retry, a double click) have the
//     same predecessor and state ⇒ the same key ⇒ ONE message, while a return to an earlier state has a NEW predecessor ⇒ a new key ⇒ re-sent.
import { createHash } from "node:crypto";
import { and, desc, eq, like } from "drizzle-orm";
import { db } from "../db";
import { notificationOutbox } from "../db/schema";
import { studentNamesOf } from "../db/mappers";
import { householdLineUserIds } from "./family-link";
import { enqueueLine } from "./line";
import { CAMP_CARD, campItemRef } from "./sale-items";

export async function notifyCampBooked(input: { packageId: string; weekId?: string | null; cancelled?: { date: string; half: string } }, exec: any = db): Promise<void> {
  try {
    const pkg = await exec.query.campPackages.findFirst({ where: (x: any, { eq }: any) => eq(x.id, input.packageId), with: { student: true } });
    if (!pkg?.student) return;
    const days: Array<{ date: string; half: string; campWeekId: string }> = await exec.query.campDays.findMany({
      where: (x: any, { and, eq }: any) => (input.weekId ? and(eq(x.campPackageId, input.packageId), eq(x.status, "PLANNED"), eq(x.campWeekId, input.weekId)) : and(eq(x.campPackageId, input.packageId), eq(x.status, "PLANNED"))),
    });
    // 🔻 (b, granted 2026-10-12) — the LAST planned day was just cancelled: there is no schedule left to confirm, so the family gets HER layout under the APPROVED cancel title (`cl_title`) for the day that went.
    const lastCancel = !days.length && input.cancelled ? input.cancelled : null;
    if (!days.length && !lastCancel) return;
    const accounts: string[] = await householdLineUserIds(exec, [pkg.studentId]);
    if (!accounts.length) return;
    // the package's SALE NAME (📋 DRAFT — Khwan Q3 unconfirmed; her sample was `Balance Camp Full Day Full Week`)
    const program = CAMP_CARD[campItemRef(pkg.kind, pkg.plan)]?.name ?? undefined;
    const groups = new Map<string, string[]>();
    if (lastCancel) groups.set(`cancelled|${lastCancel.half}`, [lastCancel.date]);
    for (const d of days) groups.set(`${d.campWeekId}|${d.half}`, [...(groups.get(`${d.campWeekId}|${d.half}`) ?? []), d.date]);
    const ordered = [...groups.entries()].map(([key, dates]) => [key, [...dates].sort()] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // the combined STATE the family is about to be told: every group's days (and whether it is the last-day cancel). Compared with the LAST message, never with all history.
    const batch = createHash("sha1").update(JSON.stringify(ordered)).digest("hex").slice(0, 12);
    for (const lineUserId of accounts) {
      const [last] = await exec
        .select({ id: notificationOutbox.id, payload: notificationOutbox.payload })
        .from(notificationOutbox)
        .where(and(eq(notificationOutbox.recipientLineUserId, lineUserId), like(notificationOutbox.idempotencyKey, `camp%:${input.packageId}:%`)))
        .orderBy(desc(notificationOutbox.createdAt))
        .limit(1);
      if (last && (last.payload as { batch?: string } | null)?.batch === batch) continue; // the family already holds exactly this: nothing changed
      for (const [key, sorted] of ordered) {
        const half = key.split("|")[1]!;
        const payload = {
          kind: "camp_booked_parent",
          studentName: studentNamesOf({ student: pkg.student }) ?? "", // the ONE name rule
          ...(program ? { program } : {}),
          dates: sorted,
          half,
          ...(lastCancel ? { cancelled: true } : {}), // the renderer swaps the title for the approved cancel one
          ...(pkg.note ? { note: pkg.note } : {}), // `Remark` = the package's own note, only when it has one
          batch, // the combined state this message belongs to (what the NEXT call compares against)
        };
        await enqueueLine({ recipientType: "parent", recipientLineUserId: lineUserId, payload, idempotencyKey: `camp:${input.packageId}:${lineUserId}:after:${last?.id ?? "none"}:${batch}:${key}` }, exec);
      }
    }
  } catch (e) {
    console.error("[camp-booked] the family notice failed — the booking stands:", e instanceof Error ? e.message : e);
  }
}
