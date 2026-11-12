// SPEC-099 §2.3 / TASK-864 — what a confirmed sale is WORTH, and which revenue line it becomes. PURE: no db, no clock, no
// I/O, so every rule here is a unit test and the file can be imported anywhere without an import cycle.
//
// 🔑 It COPIES NO PRICE RULE. Every amount is built from the helpers the day-end posting already uses —
// `revenueItemRef`, `listPriceMinor`, `courseItemRef`, `voucherItemRef`, `safeStoredDiscount`, `OTHER_BOOKING_REF`
// (`lib/sale-items.ts`, `lib/discount-plan.ts`) — so the amount at confirm and the movement at day-end cannot disagree
// about a rule. The two inputs that need the database (`priceGroup`, the posted course movements) are passed IN by the
// caller (`lib/revenue-line.ts`), which is what keeps this file free of `scheduler.service`.
//
// Each function returns the whole `RevenueLineInput` (key, type, category, product name, amount) or `null`. A `null`
// is never silent: it says why on `console.error` with the key — this desk's second rule for revenue (`sale-post.ts`).
import { listPriceMinor, revenueItemRef, voucherItemRef } from "./sale-items";
import { safeStoredDiscount } from "./discount-plan";

/** SPEC-098 §2 — the 8 revenue types a category can belong to (REFUND is a line type only, never written here). */
export type RevenueType = "COURSE" | "TRIAL" | "VOUCHER" | "ECA" | "SALES" | "FNB" | "RENT" | "OTHER";

/**
 * 🔻 TASK-889 (F1, SPEC-099 §9) — the two branches. `bookings` / `course_packages` / `vouchers` each carry one (default BRAVO); a revenue line
 * takes the branch of the row that PRODUCED it. A value that is absent or not one of the two reads as BRAVO (the column's default), never as a guess.
 */
export const BRANCHES = ["BRAVO", "OTHER"] as const;
export type Branch = (typeof BRANCHES)[number];
export const isBranch = (v: unknown): v is Branch => v === "BRAVO" || v === "OTHER";
export const branchOf = (v: unknown): Branch => (isBranch(v) ? v : "BRAVO");

/** What `writeRevenueLine` takes. `occurredOn` is optional: omitted ⇒ the Asia/Bangkok date of the write (R2.2). */
export interface RevenueLineInput {
  idempotencyKey: string;
  type: RevenueType;
  categoryName: string;
  productName: string;
  amountMinor: number;
  /** SPEC-098 `source`: 'BOOKING' for course · trial · 1 HR · park fee · voucher; 'RENT' for a rental. */
  source: "BOOKING" | "RENT";
  /** What produced it — 'BOOKING' | 'COURSE' | 'VOUCHER' | 'RENTAL' | 'CAMP' (🔻 TASK-900: a confirmed camp package). */
  refType: "BOOKING" | "COURSE" | "VOUCHER" | "RENTAL" | "CAMP";
  refId: string;
  occurredOn?: string;
  /** 🔻 TASK-889 — the source row's branch. Omitted ⇒ BRAVO. */
  branch?: Branch;
  /** 🔻 TASK-900 — an explicit method (the admin's choice at "Confirm camp"). Omitted ⇒ payment row 1's method for a COURSE / VOUCHER line, else TRANSFER. */
  method?: "TRANSFER" | "CASH" | "CARD";
}

const skip = (key: string, why: string): null => {
  console.error(`[revenue] NOT WRITTEN — ${key}: ${why}. This sale is NOT in the revenue ledger.`);
  return null;
};

/** `<subject> — <who>`, tolerating a missing child name (the line still has to be readable). */
const withWho = (head: string, who: string | null | undefined): string => (who && who.trim() ? `${head} — ${who.trim()}` : head);

/**
 * 🔻 TASK-961 (SPEC-106 §4) — THE revenue-category name for a sale of `subject`: ONE builder, called by `courseLine` / `trialOrSingleLine` (the writer) AND by `relabelRevenueLine` (the activity change), so a relabelled line can never carry a name
 * the writer would not have built. COURSE → «<subject> · Private|Duo»; a 1 HR → «<subject> · 1 HR» (type COURSE); a 1st Trial → «1st Trial (<subject>)» (type TRIAL).
 */
export type RevenueCategoryKind = "COURSE" | "SINGLE_SESSION" | "FIRST_TRIAL";
export const revenueCategoryName = (kind: RevenueCategoryKind, subject: string, duo = false): string =>
  kind === "COURSE" ? `${subject} · ${duo ? "Duo" : "Private"}` : kind === "FIRST_TRIAL" ? `1st Trial (${subject})` : `${subject} · 1 HR`;
export const revenueCategoryType = (kind: RevenueCategoryKind): RevenueType => (kind === "FIRST_TRIAL" ? "TRIAL" : "COURSE");

// ───────────────────────────────── trial · 1 HR (applyConfirm) ─────────────────────────────────

export interface ConfirmedBookingFacts {
  id: string;
  bookingType: string;
  subjectName: string | null;
  /** `studentNamesOf` of the booking — the ONE name rule (a DUO's `A & B`). */
  who: string | null;
  discountKind?: string | null;
  discountValue?: number | null;
  discountReason?: string | null;
  discountActor?: string | null;
  /** 🔻 TASK-889 — `bookings.branch`. */
  branch?: string | null;
}

/**
 * A confirmed FIRST_TRIAL or SINGLE_SESSION. The amount is the same one `postTrialOrSingleSale` (jobs.service) posts:
 * the catalogue list price of `revenueItemRef(bookingType, priceGroup)` less the stored discount, re-validated against
 * that price (`safeStoredDiscount` drops an invalid one, loudly, and the sale is then at full price).
 */
export function trialOrSingleLine(b: ConfirmedBookingFacts, priceGroup: string | null): RevenueLineInput | null {
  const key = `rl:booking:${b.id}`;
  if (b.bookingType !== "FIRST_TRIAL" && b.bookingType !== "SINGLE_SESSION") return skip(key, `bookingType ${b.bookingType} is not a trial or a single session`);
  const ref = revenueItemRef(b.bookingType, priceGroup);
  if (!ref) return skip(key, "no price group for the booking's program, so its single-session rate is unknown");
  const list = listPriceMinor(ref);
  if (list === undefined || list <= 0) return skip(key, `no list price for ${ref}`);
  const discount = b.discountKind
    ? safeStoredDiscount(
        { kind: b.discountKind as "PERCENT" | "BAHT", value: b.discountValue ?? 0, reason: b.discountReason ?? "" },
        list,
        b.discountActor ?? null,
        b.id,
      )
    : undefined;
  const amountMinor = list - (discount?.discountMinor ?? 0);
  if (amountMinor <= 0) return skip(key, `net amount is ${amountMinor} after the discount`);
  const subject = b.subjectName?.trim();
  if (!subject) return skip(key, "the booking has no subject, so its category is unknown");
  const trial = b.bookingType === "FIRST_TRIAL";
  return {
    idempotencyKey: key,
    type: trial ? "TRIAL" : "COURSE",
    categoryName: revenueCategoryName(trial ? "FIRST_TRIAL" : "SINGLE_SESSION", subject), // 🔻 TASK-961 — the ONE builder
    productName: withWho(trial ? `${subject} Trial` : `${subject} 1 HR`, b.who),
    amountMinor,
    source: "BOOKING",
    refType: "BOOKING",
    refId: b.id,
    branch: branchOf(b.branch),
  };
}

// ───────────────────────────────── course (first confirm) ─────────────────────────────────

/** The NET posted sale of a course: the sum of its sale movement and its discount movement (`value_minor`, discount is negative). */
export function netSaleMinor(rows: readonly { valueMinor: number }[]): number {
  return rows.reduce((a, r) => a + r.valueMinor, 0);
}

/** The two idempotency keys a course's money is posted under (`createCoursePackage`: `recordSale` + `discountMovement`). Read, never guessed. */
export const courseSaleKeys = (courseId: string): string[] => [`course-sale:${courseId}`, `discount:${courseId}`];

/**
 * A course's first confirm. `netMinor` is what was actually POSTED (`netSaleMinor` of the rows found under
 * `courseSaleKeys`), or `null` when no sale movement exists — then there is no line, loudly, never an invented price.
 */
export function courseLine(
  c: { id: string; subjectName: string | null; duo: boolean; who: string | null; branch?: string | null },
  netMinor: number | null,
): RevenueLineInput | null {
  const key = `rl:course:${c.id}`;
  if (netMinor === null) return skip(key, `no posted sale movement for course ${c.id} (keys ${courseSaleKeys(c.id).join(", ")})`);
  if (netMinor <= 0) return skip(key, `the course's net posted sale is ${netMinor}`);
  const subject = c.subjectName?.trim();
  if (!subject) return skip(key, "the course has no subject, so its category is unknown");
  const kind = c.duo ? "Duo" : "Private";
  return {
    idempotencyKey: key,
    type: "COURSE",
    categoryName: revenueCategoryName("COURSE", subject, c.duo), // 🔻 TASK-961 — the ONE builder
    productName: withWho(`${subject} ${kind}`, c.who),
    amountMinor: netMinor,
    source: "BOOKING",
    refType: "COURSE",
    refId: c.id,
    branch: branchOf(c.branch),
  };
}

// ───────────────────────────────── park fee (OTHER with the system teacher) ─────────────────────────────────

/**
 * An OTHER booking whose teacher `is_system` (F5 "No Teacher") is a PARK FEE. The amount is what the day-end posts:
 * a catalogue item's price READ NOW (`otherPriceItemId`; the caller passes the item, or `null` when it is missing),
 * else the typed `otherPriceMinor`. An inactive or missing item writes nothing (no fallback price is invented).
 */
export function parkFeeLine(
  b: { id: string; otherPriceMinor: number | null; otherPriceItemId: string | null; branch?: string | null },
  item: { active: boolean; unitPriceMinor: number } | null,
): RevenueLineInput | null {
  const key = `rl:booking:${b.id}`;
  let amountMinor: number | null;
  if (b.otherPriceItemId) {
    if (!item || !item.active) return skip(key, `the park fee was charged to catalogue item ${b.otherPriceItemId}, which is ${item ? "INACTIVE" : "missing"}`);
    amountMinor = item.unitPriceMinor;
  } else {
    amountMinor = b.otherPriceMinor;
  }
  if (amountMinor === null || !Number.isInteger(amountMinor) || amountMinor <= 0) return skip(key, `the park fee is not a positive amount (${amountMinor})`);
  return {
    idempotencyKey: key,
    type: "RENT",
    categoryName: "PARK",
    productName: "Park fee",
    amountMinor,
    source: "BOOKING",
    refType: "BOOKING",
    refId: b.id,
    branch: branchOf(b.branch),
  };
}

// ───────────────────────────────── voucher (createVoucher) ─────────────────────────────────

/** A voucher sold: list price of `voucher-<hours>` less the discount `validateSaleDiscount` already accepted (a positive number of satang). */
export function voucherLine(
  v: { id: string; hours: number; who: string | null; branch?: string | null },
  discountMinor: number,
): RevenueLineInput | null {
  const key = `rl:voucher:${v.id}`;
  const list = listPriceMinor(voucherItemRef(v.hours));
  if (list === undefined || list <= 0) return skip(key, `no list price for voucher-${v.hours}`);
  const amountMinor = list - discountMinor;
  if (amountMinor <= 0) return skip(key, `net amount is ${amountMinor} after the discount`);
  return {
    idempotencyKey: key,
    type: "VOUCHER",
    categoryName: `${v.hours} Hr`,
    productName: withWho(`Voucher ${v.hours} Hr`, v.who),
    amountMinor,
    source: "BOOKING",
    refType: "VOUCHER",
    refId: v.id,
    branch: branchOf(v.branch),
  };
}

// ───────────────────────────────── rental (every rental post) ─────────────────────────────────

/**
 * A rental posted: what that post NETS = `list × hours` less the discount `recordRental` already validated.
 * It covers all three posts that go through `recordRental`: the paid press (`hours 1`, no discount), a course's
 * paid-upfront rental (`hours = size`) and a standalone rental (its own discount).
 *
 * The key is `rl:` + the MOVEMENT's own idempotency key (`rental:<idBase>:<code>`, i.e. `rl:rental:<idBase>:<code>`),
 * so the ledger line is exactly as unique as the sale it mirrors and a retried post hits the same key. `refId` is
 * the booking / course / client id the rental belongs to.
 */
export function rentalLine(
  r: { movementKey: string; refId: string; code: string; hours: number; branch?: string | null },
  discountMinor = 0,
): RevenueLineInput | null {
  const key = `rl:${r.movementKey}`;
  const list = listPriceMinor(r.code);
  if (list === undefined || list <= 0) return skip(key, `no list price for rental code ${r.code}`);
  const amountMinor = list * r.hours - discountMinor;
  if (amountMinor <= 0) return skip(key, `net amount is ${amountMinor} after the discount`);
  return {
    idempotencyKey: key,
    type: "RENT",
    categoryName: "EQUIPMENT",
    productName: "Equipment rent",
    amountMinor,
    source: "RENT",
    refType: "RENTAL",
    refId: r.refId,
    branch: branchOf(r.branch), // 🔻 TASK-889 (F1) — the ref's branch (course / booking); standalone ⇒ BRAVO
  };
}
