// TASK-066 — the ONE definition of what a sale's product code is, and what item it posts to.
//
// Before this, the codes were spelled in three places: `revenueItemRef` (trial/single), and two
// inline template strings in scheduler.service (`course-${size}` / `voucher-${hours}`). Nothing tied
// them to the backoffice items they're supposed to hit — which is part of why nobody noticed that
// the course/voucher items had never been created at all. One list, used by both the sale path and
// the ensure-items script, so a code can't exist without an item to post it to.
//
// Pure — no DB, no I/O.

/** `bo.item.external_source` for everything this app sells. */
export const SALE_SOURCE = "smart-scheduler";

export const COURSE_SIZES = [4, 6, 10] as const;
export const VOUCHER_HOURS = [5, 10, 15] as const;

export const courseItemRef = (size: number): string => `course-${size}`;
export const voucherItemRef = (hours: number): string => `voucher-${hours}`;

/** Booking type → its INCOME product code for day-end revenue (TASK-007). Only one-off
 *  trial/single recognise revenue at attendance; course/voucher already posted at sale, so they
 *  map to null and are not re-posted. */
export function revenueItemRef(bookingType: string): string | null {
  if (bookingType === "FIRST_TRIAL") return "first-trial";
  if (bookingType === "SINGLE_SESSION") return "single-session";
  return null;
}

const THB = (baht: number) => baht * 100; // satang

// ⚠️ PLACEHOLDER PRICING — NOT a real price list. See TASK-066 notes.
//
// ฿1,390 per hour is the *existing* placeholder already live for first-trial / single-session
// (seeded 2026-07-20, project-docs/seed-data-placeholder-2026-07-20.md §4). Every other price below
// is that same figure × the product's hours — i.e. derived from an approved placeholder, not a
// number I chose. Real courses almost certainly carry a bulk discount, so these are very likely
// TOO HIGH for the 6- and 10-session packages. They are marked `metadata.pricePlaceholder: true`
// so they are identifiable in the data, not just in a comment. @Porter is chasing the real figures.
export const PLACEHOLDER_HOURLY_MINOR = THB(1390);

export interface SaleItemSeed {
  externalRef: string;
  name: string;
  hours: number;
  unitPriceMinor: number;
}

const seed = (externalRef: string, name: string, hours: number): SaleItemSeed => ({
  externalRef,
  name,
  hours,
  unitPriceMinor: PLACEHOLDER_HOURLY_MINOR * hours,
});

/** Every INCOME item a sale can post to. The ensure-items script creates exactly these. */
export const SALE_ITEMS: SaleItemSeed[] = [
  seed("first-trial", "First Trial (1h)", 1),
  seed("single-session", "Single Session (1h)", 1),
  ...COURSE_SIZES.map((size) => seed(courseItemRef(size), `Course Package (${size} sessions)`, size)),
  ...VOUCHER_HOURS.map((hours) => seed(voucherItemRef(hours), `Voucher (${hours}h)`, hours)),
];

/** Is this a product code we know how to post? Guards against a sale silently going nowhere. */
export const isKnownSaleItem = (externalRef: string): boolean =>
  SALE_ITEMS.some((i) => i.externalRef === externalRef);
