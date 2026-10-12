// 🔻 TASK-735 (D2, Khwan's row 46; 📋 DRAFT — Q3 pending: the `Program` wording) — the FAMILY is told what is BOOKED for a camp package: when days are booked, again when they change, and
// again when one is cancelled (Khwan Q6: "ส่งใหม่ค่ะ"). ONE function for all three: it reads the package's CURRENT planned days (so the message always says what is true NOW) and sends
// one «CONFIRMED SCHEDULE» per (week, half) group to the student's household. The camp service calls it AFTER its transaction commits; a failed notice costs the notice, never the booking.
// Nothing planned any more ⇒ nothing is sent (there is no 'nothing left' wording yet — asked of the SA).
import { db } from "../db";
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
    for (const [key, dates] of groups) {
      const half = key.split("|")[1]!;
      const sorted = [...dates].sort();
      const payload = {
        kind: "camp_booked_parent",
        studentName: studentNamesOf({ student: pkg.student }) ?? "", // the ONE name rule
        ...(program ? { program } : {}),
        dates: sorted,
        half,
        ...(lastCancel ? { cancelled: true } : {}), // the renderer swaps the title for the approved cancel one
        ...(pkg.note ? { note: pkg.note } : {}), // `Remark` = the package's own note, only when it has one
      };
      for (const lineUserId of accounts) {
        // send-once per STATE: the same booked days never go twice; a changed set (a day added or cancelled) is a new key ⇒ a new message
        await enqueueLine({ recipientType: "parent", recipientLineUserId: lineUserId, payload, idempotencyKey: `${lastCancel ? "camp-cancelled" : "camp-booked"}:${input.packageId}:${key}:${sorted.join(",")}:${lineUserId}` }, exec);
      }
    }
  } catch (e) {
    console.error("[camp-booked] the family notice failed — the booking stands:", e instanceof Error ? e.message : e);
  }
}
