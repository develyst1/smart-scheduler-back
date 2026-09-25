// TASK-475 (REQ-108) — the shop-front QR self check-in: phone → the children with something check-in-able RIGHT NOW →
// the class → checked in.
//
// 🔑 The credential is a PHONE NUMBER and nothing else — the owner's ruling (§0): the person at the counter is often a
// nanny or a driver with no access to the parent's LINE. So the guards ARE the feature:
//  1. today, inside the live check-in window (early + K5's late), and never a settled session — enforced by the SAME
//     act (`checkinByToken`), and mirrored in the list so nothing is offered that the act would refuse;
//  2. 🔴 only the children with something check-in-able NOW — never the family list. Nothing ⇒ `{ children: [] }`, and an
//     unknown number · an archived holder · a SUSPENDED household · a family with nothing now are INDISTINGUISHABLE: same
//     body, and the same reads run, so the answer does not tell a stranger which numbers are customers;
//  3. the parent's notice — whatever the same act sends (⚠️ course/voucher sessions only; camp's at day-end — TASK-475 §A2);
//  4. the rate limit, in the route (`lib/shopfront-rate-limit.ts`).
// 🔴 THE ACT IS NOT RE-IMPLEMENTED HERE. A session goes through `getCheckinQr` → `checkinByToken` — exactly the LINE
// button's two calls — and a camp day through `getDayCheckinQr` → `checkinCampByToken`. Pinned by source.
import { db } from "../db";
import { conflict } from "../lib/http";
import { bangkokNow, type BangkokNow } from "../lib/bangkok-time";
import { isWithinCheckinWindow } from "../lib/checkin";
import { hhmm } from "../lib/time";
import { isSuspended } from "../lib/suspend";
import { familyRowsWhere } from "../lib/duo-course";
import { studentNamesOf } from "../db/mappers";
import { findParentByPhone } from "./parent.service";
import { getNumberSetting, getSetting } from "./settings.service";
import { checkinByToken, getCheckinQr } from "./checkin.service";
import { checkinCampByToken, getDayCheckinQr } from "./camp.service";

export type ShopfrontItem =
  | { kind: "session"; bookingId: string; date: string; startTime: string; endTime: string; program: string; teacher: string }
  | { kind: "camp"; campDayId: string; date: string; half: string };
export type ShopfrontChild = { name: string; items: ShopfrontItem[] };

/** One neutral sentence for every "nothing" — never a name, never a reason (guard 2). */
export const NOT_CHECKINABLE = () => conflict("NOT_CHECKINABLE", "ไม่มีคลาสให้เช็คอินในขณะนี้ / No class to check in right now");
/** Matches no row: the reads still RUN for a phone with no family, so the unknown number is not the fast answer. */
const NO_ONE = "00000000-0000-0000-0000-000000000000";

/**
 * The family's children with something check-in-able RIGHT NOW, grouped by the ONE name rule (a DUO row reads both, once).
 * `{ children: [] }` for every kind of nothing — see guard 2 above.
 */
export async function shopfrontLookup(phone: string, now: BangkokNow = bangkokNow()): Promise<{ children: ShopfrontChild[] }> {
  const parent = await findParentByPhone(phone); // an ARCHIVED holder is invisible here (TASK-411)
  const usable = parent && !isSuspended(parent.suspendedAt); // ❓4 — suspended ⇒ the neutral empty list, as the LINE path refuses
  const kids = await db.query.students.findMany({
    where: (s: any, { eq: e, and: a, isNull: n }: any) => a(e(s.parentId, usable ? parent!.id : NO_ONE), n(s.archivedAt)),
  });
  const ids = kids.length ? kids.map((k: any) => k.id as string) : [NO_ONE];

  const { value: earlyMinutes } = await getSetting("checkin_early_minutes");
  const lateMinutes = await getNumberSetting("checkin_late_minutes");
  const sessions = await db.query.bookings.findMany({
    where: (b: any, { and: a, eq: e, isNull: n }: any) => a(e(b.date, now.date), e(b.status, "CONFIRMED"), n(b.campWeekDayId), familyRowsWhere(ids)),
    with: { student: true, coStudent: true, teacher: true, subject: true },
    orderBy: (b: any, { asc }: any) => asc(b.startTime),
  });
  // ❓3 — camp: PLANNED only. An unauthenticated wall QR never overturns a staff-marked absence.
  const campRows = await db.query.campDays.findMany({
    where: (d: any, { and: a, eq: e }: any) => a(e(d.date, now.date), e(d.status, "PLANNED")),
    with: { package: { with: { student: true } } },
  });

  const byName = new Map<string, ShopfrontItem[]>();
  const add = (name: string, item: ShopfrontItem) => byName.set(name, [...(byName.get(name) ?? []), item]);
  for (const b of sessions as any[]) {
    if (!isWithinCheckinWindow(b.date, hhmm(b.startTime), hhmm(b.endTime), now, earlyMinutes, lateMinutes)) continue;
    add(studentNamesOf(b) ?? "-", {
      kind: "session", bookingId: b.id, date: b.date, startTime: hhmm(b.startTime), endTime: hhmm(b.endTime),
      program: b.subject?.name ?? "-", teacher: `Teacher ${b.teacher?.nickname ?? "-"}`,
    });
  }
  for (const d of campRows as any[]) {
    if (!ids.includes(d.package?.studentId)) continue;
    add(studentNamesOf({ student: d.package?.student }) ?? "-", { kind: "camp", campDayId: d.id, date: d.date, half: d.half });
  }
  return { children: [...byName].map(([name, items]) => ({ name, items })) };
}

/**
 * The act. 🔴 Re-runs the lookup and requires the id to be in THIS phone's CURRENT list — a `bookingId` alone can never
 * check anything in, and every guard is re-applied at the moment of the act. Then the SAME act as every other path.
 */
export async function shopfrontCheckin(
  input: { phone: string; bookingId?: string; campDayId?: string },
  now: BangkokNow = bangkokNow(),
) {
  const { children } = await shopfrontLookup(input.phone, now);
  const items = children.flatMap((c) => c.items);
  if (input.bookingId && items.some((i) => i.kind === "session" && i.bookingId === input.bookingId)) {
    const qr = await getCheckinQr(input.bookingId);
    return checkinByToken(qr.token, "shopfront-qr");
  }
  if (input.campDayId && items.some((i) => i.kind === "camp" && i.campDayId === input.campDayId)) {
    const qr = await getDayCheckinQr(input.campDayId);
    return checkinCampByToken(qr.token, "shopfront-qr");
  }
  throw NOT_CHECKINABLE();
}
