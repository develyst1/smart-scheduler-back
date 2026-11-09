// TASK-900 (SPEC-099 §11, REQ-120 §8 D3 = B) — "Confirm camp". A camp package is SOLD when it is booked (`camp-sale:<id>` posts its money) but its REVENUE
// counts on the day the admin CONFIRMS it. No schema change: a package is confirmed exactly when its revenue line `rl:camp:<packageId>` exists.
//
// One confirm writes, in ONE transaction:
//   • the revenue line `rl:camp:<id>`: type COURSE, category "Balance Camp", amount = the camp's NET posted sale (`camp-sale:<id>` + `discount:<id>`),
//     `occurred_on` = TODAY (Bangkok) — the date the admin confirms — method = the chosen one, source BOOKING, ref_type CAMP (the existing writer,
//     `writeRevenueLine`, TASK-864: not copied);
//   • the payment row 1 (`bo.payment`, ref_type CAMP, n 1): `paid_on` = the "Date received" the admin typed, the same net, the same method
//     (the existing writer, `createSalePayment`, TASK-875: not copied).
// No posted sale (or a net of zero) → 409 NO_FEE. A second confirm → 409 ALREADY_CONFIRMED, and nothing is written. A failure of either write rolls BOTH back
// (the writers log and return `ok:false` instead of throwing, so this file turns that into a throw inside the transaction).
// No LINE message is sent by a confirm. Branch: BRAVO (a camp has no branch column; F1 is not in scope here).
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { boRevenueLine } from "../db/bo-revenue";
import { badRequest, conflict, notFound } from "./http";
import { bangkokNow } from "./bangkok-time";
import { createSalePayment, feeFromMovements, feeKeys, feeOf, revenueLineKeyFor, type PaymentMethod, PAYMENT_METHODS } from "./payment-record";
import { boMovement } from "../db/schema"; // 🔻 TASK-916
import { writeRevenueLine } from "./revenue-line";

export const CAMP_CATEGORY = "Balance Camp";
/** The revenue line a confirmed camp package owns: `rl:camp:<packageId>`. */
export const campLineKey = (packageId: string): string => revenueLineKeyFor("CAMP", packageId);

export interface CampConfirmResult {
  packageId: string;
  /** The date the revenue counts on: today, Bangkok. */
  confirmedOn: string;
  amountMinor: number;
  method: PaymentMethod;
}

const isRealDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
};

/** `<nickname else name>`, or null. */
const whoOf = (s: { nickname?: string | null; name?: string | null } | null | undefined): string | null =>
  s?.nickname?.trim() ? s.nickname.trim() : s?.name?.trim() ? s.name.trim() : null;

export async function confirmCamp(
  packageId: string,
  input: { receivedOn: string; method: PaymentMethod },
  d: any = db,
  today: string = bangkokNow().date,
): Promise<CampConfirmResult> {
  if (!isRealDate(input.receivedOn)) throw badRequest("receivedOn must be a real date, YYYY-MM-DD");
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.method)) throw badRequest("method must be TRANSFER, CASH or CARD");

  return d.transaction(async (tx: any) => {
    const pkg = await tx.query.campPackages.findFirst({ where: (p: any, { eq: e }: any) => e(p.id, packageId) });
    if (!pkg) throw notFound("ไม่พบแพ็กเกจแคมป์");
    // two confirms at once: the second waits here, then sees the first's line (and the line's unique key is the second wall)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`camp-confirm:${packageId}`}))`);

    const [existing] = await tx.select({ id: boRevenueLine.id }).from(boRevenueLine).where(eq(boRevenueLine.idempotencyKey, campLineKey(packageId))).limit(1);
    if (existing) throw conflict("ALREADY_CONFIRMED", "แพ็กเกจแคมป์นี้ยืนยันแล้ว");

    const fee = await feeOf(tx, "CAMP", packageId);
    if (fee === null || fee <= 0) throw conflict("NO_FEE", "แพ็กเกจแคมป์นี้ยังไม่มียอดขายที่บันทึกไว้ จึงยืนยันไม่ได้");

    const student = pkg.studentId ? await tx.query.students.findFirst({ where: (s: any, { eq: e }: any) => e(s.id, pkg.studentId) }) : null;
    const who = whoOf(student);
    const line = await writeRevenueLine(tx, {
      idempotencyKey: campLineKey(packageId),
      type: "COURSE",
      categoryName: CAMP_CATEGORY,
      productName: who ? `${CAMP_CATEGORY} — ${who}` : CAMP_CATEGORY,
      amountMinor: fee,
      source: "BOOKING",
      refType: "CAMP",
      refId: packageId,
      occurredOn: today,
      method: input.method,
    });
    if (line.skipped === "duplicate") throw conflict("ALREADY_CONFIRMED", "แพ็กเกจแคมป์นี้ยืนยันแล้ว");
    if (!line.ok) throw new Error(`camp ${packageId}: the revenue line was not written (${line.skipped}); the confirm is rolled back`);

    const pay = await createSalePayment("CAMP", packageId, fee, tx, input.receivedOn, input.method);
    if (!pay.ok) throw new Error(`camp ${packageId}: the payment row was not written (${pay.skipped}); the confirm is rolled back`);

    return { packageId, confirmedOn: today, amountMinor: fee, method: input.method };
  });
}

/** package id → the date it was confirmed (its line's `occurred_on`); a package not in the map is not confirmed. One query for the whole list. */
export async function confirmedOnByPackage(ids: readonly string[], d: any = db): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const keys = ids.map(campLineKey);
  const rows: { key: string | null; occurredOn: string }[] = await d
    .select({ key: boRevenueLine.idempotencyKey, occurredOn: boRevenueLine.occurredOn })
    .from(boRevenueLine)
    .where(inArray(boRevenueLine.idempotencyKey, keys));
  const byKey = new Map(rows.map((r) => [r.key, r.occurredOn]));
  return new Map(ids.flatMap((id) => (byKey.has(campLineKey(id)) ? [[id, byKey.get(campLineKey(id))!] as [string, string]] : [])));
}

/**
 * 🔻 TASK-916 — the camp list's `amountMinor`: package id → its NET posted sale (`camp-sale:<id>` + `discount:<id>`), for the whole list in ONE query. It is the
 * very number `confirmCamp` records, by the very same rule (`feeFromMovements`, not a copy): a package with no posted sale, or a net of 0 or less, is NOT in the
 * map (that is exactly the `NO_FEE` case of the confirm), so the caller reads `map.get(id) ?? null`.
 */
export async function feeByPackage(ids: readonly string[], d: any = db): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const keys = ids.flatMap((id) => Object.values(feeKeys("CAMP", id)));
  const rows: { key: string | null; valueMinor: number }[] = await d
    .select({ key: boMovement.idempotencyKey, valueMinor: boMovement.valueMinor })
    .from(boMovement)
    .where(inArray(boMovement.idempotencyKey, keys));
  const out = new Map<string, number>();
  for (const id of ids) {
    const net = feeFromMovements("CAMP", id, rows); // filters to THIS package's two keys
    if (net !== null && net > 0) out.set(id, net);
  }
  return out;
}
