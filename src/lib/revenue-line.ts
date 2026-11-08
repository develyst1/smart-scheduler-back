// SPEC-099 §2.1 / TASK-864 — write ONE row of the revenue ledger (`bo.revenue_line`, SPEC-098), and the four entry
// points the sale paths call (confirm · course · voucher · rental).
//
// Two rules this file holds — the same two as `sale-post.ts`, which it is modelled on:
//   1. It must NEVER fail the sale / confirm it describes. Revenue is downstream bookkeeping; the booking is the event.
//   2. It must NEVER fail silently. Every non-write is `console.error` with the key and the reason.
//
// 🔴 "Never fail the caller" is easy to say and easy to get wrong INSIDE a transaction: a statement that errors in
// Postgres aborts the WHOLE transaction ("current transaction is aborted"), and the confirm that called us dies on its
// next statement. So every entry point runs in a SAVEPOINT (`exec.transaction`, which on a transaction is a savepoint
// and on `db` is a transaction of its own). A failure rolls back to the savepoint and the caller carries on. If the
// confirm itself rolls back later, the line rolls back with it: it is part of the same transaction.
import { and, eq, inArray, sql } from "drizzle-orm";
import { boMovement } from "../db/schema";
import { boPayment, boRevenueCategory, boRevenueLine } from "../db/bo-revenue";
import { studentNamesOf } from "../db/mappers";
import { bangkokNow } from "./bangkok-time";
import {
  courseLine,
  courseSaleKeys,
  netSaleMinor,
  parkFeeLine,
  rentalLine,
  trialOrSingleLine,
  voucherLine,
  type RevenueLineInput,
} from "./booking-sale-amount";

/** Fixed until F1 / F2 put a branch and a payment method on the sale (SPEC-099 §2.4–§2.5). */
export const DEFAULT_BRANCH = "BRAVO";
export const DEFAULT_METHOD = "TRANSFER";

/**
 * SPEC-099 §8.4 / TASK-875 — a COURSE / VOUCHER line takes its method from the sale's payment ROW 1 (the SF may have set
 * CASH / CARD with a PATCH before the confirm wrote the line); `TRANSFER` when there is no row yet (or no table yet).
 * Read in a NESTED savepoint, so a missing `bo.payment` (migration 0012 not applied) aborts only the read, never the line.
 */
async function methodFromRowOne(sp: any, line: RevenueLineInput): Promise<string> {
  if ((line.refType !== "COURSE" && line.refType !== "VOUCHER") || !line.refId) return DEFAULT_METHOD;
  try {
    const rows: { method: string }[] = await sp.transaction(async (np: any) =>
      np
        .select({ method: boPayment.method })
        .from(boPayment)
        .where(and(eq(boPayment.refType, line.refType), eq(boPayment.refId, line.refId), eq(boPayment.n, 1)))
        .limit(1),
    );
    const m = rows[0]?.method;
    return m === "CASH" || m === "CARD" || m === "TRANSFER" ? m : DEFAULT_METHOD;
  } catch (e) {
    console.error(`[revenue] payment method not read for ${line.idempotencyKey} — using ${DEFAULT_METHOD}:`, e);
    return DEFAULT_METHOD;
  }
}

export interface RevenueWriteResult {
  ok: boolean;
  /** Set when nothing was written. `duplicate` is a success (the key was already there). */
  skipped?: "duplicate" | "bad-amount" | "error";
}

/**
 * Insert one revenue line, creating its category by name if it does not exist yet.
 *
 * - **Idempotent** on `idempotencyKey` (`ON CONFLICT (idempotency_key) DO NOTHING`).
 * - **Category by name:** matched on `(type, lower(name))`; a missing one is inserted (`ON CONFLICT DO NOTHING`, then
 *   re-read), so a new subject name never loses revenue and the admin can rename it later (R2.1).
 * - `branch` = BRAVO, `method` = TRANSFER, `actor` = null (service writer) until F1 / F2.
 * - `occurredOn` defaults to the Asia/Bangkok calendar date of the write.
 */
export async function writeRevenueLine(exec: any, line: RevenueLineInput): Promise<RevenueWriteResult> {
  const key = line.idempotencyKey;
  // The table's CHECK would reject this anyway; saying so here keeps the reason readable instead of a pg error code.
  if (!Number.isInteger(line.amountMinor) || line.amountMinor <= 0) {
    console.error(`[revenue] NOT WRITTEN — ${key}: amount must be a positive integer in satang, got ${line.amountMinor}. This sale is NOT in the revenue ledger.`);
    return { ok: false, skipped: "bad-amount" };
  }
  try {
    return await exec.transaction(async (sp: any): Promise<RevenueWriteResult> => {
      const findCategory = async () => {
        const [c] = await sp
          .select({ id: boRevenueCategory.id })
          .from(boRevenueCategory)
          .where(and(eq(boRevenueCategory.type, line.type), sql`lower(${boRevenueCategory.name}) = lower(${line.categoryName})`))
          .limit(1);
        return c as { id: string } | undefined;
      };
      let category = await findCategory();
      if (!category) {
        const [{ next }] = await sp
          .select({ next: sql<number>`coalesce(max(${boRevenueCategory.sortOrder}), -1) + 1` })
          .from(boRevenueCategory)
          .where(eq(boRevenueCategory.type, line.type));
        await sp.insert(boRevenueCategory).values({ type: line.type, name: line.categoryName, sortOrder: Number(next) }).onConflictDoNothing();
        category = await findCategory();
        if (!category) throw new Error(`category ${line.type} / "${line.categoryName}" is missing after its insert`);
      }
      const method = await methodFromRowOne(sp, line);
      const inserted = await sp
        .insert(boRevenueLine)
        .values({
          occurredOn: line.occurredOn ?? bangkokNow().date,
          branch: DEFAULT_BRANCH,
          type: line.type,
          categoryId: category.id,
          productName: line.productName,
          amountMinor: line.amountMinor,
          method,
          source: line.source,
          refType: line.refType,
          refId: line.refId,
          idempotencyKey: key,
          actor: null,
        })
        .onConflictDoNothing({ target: boRevenueLine.idempotencyKey })
        .returning({ id: boRevenueLine.id });
      return inserted.length ? { ok: true } : { ok: true, skipped: "duplicate" };
    });
  } catch (e) {
    console.error(`[revenue] NOT WRITTEN — write failed (${key}). This sale is NOT in the revenue ledger:`, e);
    return { ok: false, skipped: "error" };
  }
}

/** Run `fn` in a savepoint; whatever it throws is logged, never rethrown (rule 1 + rule 2). */
async function safely(exec: any, what: string, fn: (sp: any) => Promise<void>): Promise<void> {
  try {
    await exec.transaction(fn);
  } catch (e) {
    console.error(`[revenue] NOT WRITTEN — ${what}. This sale is NOT in the revenue ledger:`, e);
  }
}

/** The two helpers that live in `scheduler.service` — passed in, so this file never imports it (no import cycle). */
export interface ConfirmDeps {
  resolvePriceGroup(subjectId: string | null | undefined, groupKind?: string | null, exec?: any): Promise<string | null>;
  groupKindOf(exec: any, groupId: string | null | undefined): Promise<"DUO" | "GROUP" | null>;
}

/** The course's NET posted sale, from the movements `createCoursePackage` wrote (never guessed); `null` when there is no sale movement. */
async function courseNetPosted(sp: any, courseId: string): Promise<number | null> {
  const [saleKey] = courseSaleKeys(courseId);
  const rows: { key: string | null; valueMinor: number }[] = await sp
    .select({ key: boMovement.idempotencyKey, valueMinor: boMovement.valueMinor })
    .from(boMovement)
    .where(inArray(boMovement.idempotencyKey, courseSaleKeys(courseId)));
  return rows.some((r) => r.key === saleKey) ? netSaleMinor(rows) : null;
}

async function writeCourseLine(sp: any, courseId: string): Promise<void> {
  const course = await sp.query.coursePackages.findFirst({
    where: (c: any, { eq: e }: any) => e(c.id, courseId),
    with: { student: true, coStudent: true },
  });
  if (!course) {
    console.error(`[revenue] NOT WRITTEN — rl:course:${courseId}: the course does not exist. This sale is NOT in the revenue ledger.`);
    return;
  }
  const subject = course.subjectId ? await sp.query.subjects.findFirst({ where: (s: any, { eq: e }: any) => e(s.id, course.subjectId) }) : null;
  const line = courseLine(
    { id: courseId, subjectName: subject?.name ?? null, duo: !!course.coStudentId, who: studentNamesOf(course) },
    await courseNetPosted(sp, courseId),
  );
  if (line) await writeRevenueLine(sp, line);
}

/** `confirmCourse`: once per course, after its loop, when at least one session was confirmed. The key absorbs repeats. */
export async function postCourseRevenue(exec: any, courseId: string): Promise<void> {
  await safely(exec, `course ${courseId} first confirm`, (sp) => writeCourseLine(sp, courseId));
}

/**
 * `applyConfirm`: one confirmed booking → its revenue line, or nothing. Which kinds write is decided HERE, from the
 * booking row (re-read inside the transaction, so a narrow `current` can never starve it):
 *   a session of a COURSE → the course's line · FIRST_TRIAL → trial · SINGLE_SESSION → 1 HR ·
 *   OTHER whose teacher `is_system` → park fee · every other OTHER (Birthday …) and VOUCHER bookings → nothing.
 */
export async function postConfirmRevenue(tx: any, bookingId: string, deps: ConfirmDeps): Promise<void> {
  await safely(tx, `confirm of booking ${bookingId}`, async (sp) => {
    const b = await sp.query.bookings.findFirst({
      where: (x: any, { eq: e }: any) => e(x.id, bookingId),
      with: { subject: true, student: true, coStudent: true, teacher: true },
    });
    if (!b) return;
    if (b.courseId) {
      await writeCourseLine(sp, b.courseId);
      return;
    }
    if (b.bookingType === "FIRST_TRIAL" || b.bookingType === "SINGLE_SESSION") {
      const groupKind = b.groupId ? await deps.groupKindOf(sp, b.groupId) : null;
      const priceGroup = await deps.resolvePriceGroup(b.subjectId, groupKind, sp);
      const line = trialOrSingleLine(
        {
          id: b.id,
          bookingType: b.bookingType,
          subjectName: b.subject?.name ?? null,
          who: studentNamesOf(b),
          discountKind: b.discountKind,
          discountValue: b.discountValue,
          discountReason: b.discountReason,
          discountActor: b.discountActor,
        },
        priceGroup,
      );
      if (line) await writeRevenueLine(sp, line);
      return;
    }
    if (b.bookingType === "OTHER" && b.teacher?.isSystem) {
      const item = b.otherPriceItemId
        ? await sp.query.boItem.findFirst({ where: (i: any, { eq: e }: any) => e(i.id, b.otherPriceItemId) })
        : null;
      const line = parkFeeLine(
        { id: b.id, otherPriceMinor: b.otherPriceMinor ?? null, otherPriceItemId: b.otherPriceItemId ?? null },
        item ? { active: item.active, unitPriceMinor: item.unitPriceMinor } : null,
      );
      if (line) await writeRevenueLine(sp, line);
    }
  });
}

/** `createVoucher`, AFTER the commit (so `exec` is `db`): a voucher has no confirm step, its sale is its revenue. `discountMinor` is the one `validateSaleDiscount` already accepted. */
export async function postVoucherRevenue(exec: any, voucherId: string, discountMinor: number): Promise<void> {
  await safely(exec, `voucher ${voucherId} sale`, async (sp) => {
    const v = await sp.query.vouchers.findFirst({ where: (x: any, { eq: e }: any) => e(x.id, voucherId), with: { student: true } });
    if (!v) {
      console.error(`[revenue] NOT WRITTEN — rl:voucher:${voucherId}: the voucher does not exist. This sale is NOT in the revenue ledger.`);
      return;
    }
    const line = voucherLine({ id: voucherId, hours: v.totalHours, who: studentNamesOf(v) }, discountMinor);
    if (line) await writeRevenueLine(sp, line);
  });
}

/**
 * `recordRental`, right after its movement posted — so the paid press, a course's paid-upfront rental and a standalone
 * rental are all covered by this one call. `movementKey` is that post's own idempotency key (`rental:<idBase>:<code>`);
 * `discountMinor` is the discount `recordRental` already validated (0 when none).
 */
export async function postRentalRevenue(
  exec: any,
  r: { movementKey: string; refId: string; code: string; hours: number; discountMinor?: number },
): Promise<void> {
  await safely(exec, `rental ${r.movementKey}`, async (sp) => {
    const line = rentalLine({ movementKey: r.movementKey, refId: r.refId, code: r.code, hours: r.hours }, r.discountMinor ?? 0);
    if (line) await writeRevenueLine(sp, line);
  });
}
