// TASK-066 + TASK-077 — the ONE definition of what a sale's product code is, and what it costs.
//
// Prices are **per price GROUP × package size**, not per size. A 6-hour package is 6,490 / 7,990 / 7,490 /
// 5,290 depending on the program, so one `course-6` could never have held the real card.
//
// Keyed on the *group*, not the subject: six skate programs share one price line, so keying by subject would
// mean ~24 items where 13 are needed — and a seventh skate program would need a price invented rather than
// inherited. The subject → group mapping lives in `subjects.price_group` (data, not code) so the owner can
// add a program without a deploy.
//
// ⚠️ **Availability is the catalogue, not a rule.** Balance Play has no 4 h and bike/skate has no 1-hour rate,
// so those items simply do not exist and `isKnownSaleItem` refuses them loudly. There is deliberately no
// availability table to drift from this one.
// (REQ-061 / TASK-158: this comment used to say "Onewheel has no 10 h" — it does, at 11,900. The line was
// wrong, not just out of date, so it is corrected here rather than left to mislead the next reader.)
//
// Pure — no DB, no I/O.

/** `bo.item.external_source` for everything this app sells. */
export const SALE_SOURCE = "smart-scheduler";

/**
 * 🔴 **EVERY PRICE IN THIS FILE IS VAT-INCLUSIVE — the final amount the customer pays.**
 * Post it as-is; never add tax on top. Any net-of-VAT figure must be *derived* from these, never assumed.
 * This is a named constant rather than a comment beside a number because gross-vs-net is exactly the
 * assumption that gets made silently inside a pricing constant and then quietly misstates every report
 * built on top of it.
 */
export const PRICES_ARE_VAT_INCLUSIVE = true;

export type PriceGroup = "bike-skate" | "onewheel" | "balance-private" | "balance-group";

export const PRICE_GROUPS: PriceGroup[] = [
  "bike-skate",
  "onewheel",
  "balance-private",
  "balance-group",
];

/**
 * SPEC-030 / TASK-106 (REQ-027b) — programs a VOUCHER (hour-bucket) may NOT be used on. Onewheel and both Balance
 * Play programs are course-only per the owner; a voucher only books the drop-in bike/skate program. Enforced at
 * booking time, and exposed so the FE filters from this one source, not a hardcoded list.
 */
export const VOUCHER_EXCLUDED_GROUPS = new Set<PriceGroup>(["onewheel", "balance-private", "balance-group"]);

/** True when a voucher may book this program. A null/unknown group is NOT allowed (1st Trial etc. — no special case). */
export const voucherAllowsProgram = (group: string | null | undefined): boolean =>
  !!group && !VOUCHER_EXCLUDED_GROUPS.has(group as PriceGroup);

/** The programs a voucher CAN book — for the FE picker (derived, never hardcoded). */
export const voucherAllowedGroups = (): PriceGroup[] => PRICE_GROUPS.filter(voucherAllowsProgram);

const THB = (baht: number) => baht * 100; // satang

/**
 * The owner's card, transcribed. `undefined` = **not offered** for that group — Onewheel has no 10 h,
 * Balance Play has no 4 h, and bike/skate has no single-hour rate — there, a first single hour is 1st Trial.
 *
 * `1` is the single-session (`session-{group}`) row; 4/6/10 are course packages.
 */
const CARD: Record<PriceGroup, Partial<Record<1 | 4 | 6 | 10, number>>> = {
  "bike-skate": { 4: THB(4790), 6: THB(6490), 10: THB(9790) },
  // REQ-061 / TASK-158: 6h corrected 7,990 → 7,900 and the missing 10h added, both from the owner's card.
  onewheel: { 1: THB(1690), 4: THB(5790), 6: THB(7900), 10: THB(11900) },
  "balance-private": { 1: THB(1390), 6: THB(7490), 10: THB(11390) },
  "balance-group": { 1: THB(1090), 6: THB(5290), 10: THB(7790) },
};

export const COURSE_SIZES = [4, 6, 10] as const;
export const VOUCHER_HOURS = [5, 10, 15] as const;

/** Vouchers are hour buckets — not program-specific, so they keep a single price each. */
const VOUCHER_PRICE: Record<(typeof VOUCHER_HOURS)[number], number> = {
  5: THB(6000),
  10: THB(10500),
  15: THB(13500),
};

/** One price, all ages, not program-specific (unchanged by TASK-077). */
export const FIRST_TRIAL_MINOR = THB(1390);

export const courseItemRef = (group: string, size: number): string => `course-${group}-${size}`;
export const sessionItemRef = (group: string): string => `session-${group}`;
export const voucherItemRef = (hours: number): string => `voucher-${hours}`;

/**
 * Booking type → its INCOME product code for day-end revenue (TASK-007).
 *
 * ⚠️ **`SINGLE_SESSION` is now program-priced** (`session-{group}`): the card charges 1,690 / 1,390 / 1,090
 * for an hour depending on the program, so a flat code would post the wrong number for two groups out of
 * three. Course/voucher already posted at sale, so they stay `null` here.
 *
 * Returns `null` when the group is unknown — the caller must then refuse loudly rather than fall back to a
 * default price, which is the whole point of TASK-077.
 */
export function revenueItemRef(bookingType: string, priceGroup?: string | null): string | null {
  if (bookingType === "FIRST_TRIAL") return "first-trial";
  if (bookingType === "SINGLE_SESSION") return priceGroup ? sessionItemRef(priceGroup) : null;
  return null;
}

export interface SaleItemSeed {
  externalRef: string;
  name: string;
  unitPriceMinor: number;
  /** Extra `bo.item.metadata` merged over the seed defaults (e.g. rentals carry `revenueKind:"RENTAL"`). */
  metadata?: Record<string, unknown>;
}

// SPEC-031 / TASK-108 (REQ-028) — equipment rental as recorded revenue. A rental is just four more product codes
// through the existing `recordSale` path (no new money mechanism). VAT-inclusive per HOUR; `quantity = hours`.
export const RENTAL_CODES = ["rental-set", "rental-ride", "rental-helmet", "rental-pads"] as const;
export type RentalCode = (typeof RENTAL_CODES)[number];
export const isRentalCode = (code: string): code is RentalCode =>
  (RENTAL_CODES as readonly string[]).includes(code);

const RENTAL_PRICE: Record<RentalCode, number> = {
  "rental-set": THB(200),
  "rental-ride": THB(150),
  "rental-helmet": THB(50),
  "rental-pads": THB(50),
};
const RENTAL_NAME: Record<RentalCode, string> = {
  "rental-set": "Equipment rental — full set / hr",
  "rental-ride": "Equipment rental — ride only / hr",
  "rental-helmet": "Equipment rental — helmet / hr",
  "rental-pads": "Equipment rental — pads / hr",
};

/** SPEC-031 / TASK-123 — the rental price card for the FE (code + VAT-incl `priceMinor` only; the FE owns labels via
 *  i18n). Derived from the one authority `RENTAL_PRICE`, so no second copy of the prices can drift. */
export const rentalPriceList = (): { code: RentalCode; priceMinor: number }[] =>
  RENTAL_CODES.map((code) => ({ code, priceMinor: RENTAL_PRICE[code] }));

/** The rental seeds — marked `revenueKind:"RENTAL"` so reports separate rental from tuition (NOT program-attributed). */
export const RENTAL_ITEMS: SaleItemSeed[] = RENTAL_CODES.map((code) => ({
  externalRef: code,
  name: RENTAL_NAME[code],
  unitPriceMinor: RENTAL_PRICE[code],
  metadata: { revenueKind: "RENTAL" },
}));

/** SPEC-031: the idempotency key for a rental post — `rental:{refId ?? saleId}:{code}` (double-submit posts once). */
export const rentalIdempotencyKey = (idBase: string, code: string): string => `rental:${idBase}:${code}`;

/**
 * The stable part of a rental's idempotency key: the session `refId` (add-on — already idempotent), else the
 * client-supplied `idempotencyKey` (standalone — the client makes retries idempotent, AC #4), else `undefined`
 * → the service mints a fresh id so each un-keyed standalone rental is its own sale. `refId` always wins.
 */
export const rentalIdBase = (
  refId: string | null | undefined,
  clientKey: string | null | undefined,
): string | undefined => refId ?? clientKey ?? undefined;

/** Every INCOME item a sale can post to — exactly the combinations the card offers. */
export const SALE_ITEMS: SaleItemSeed[] = [
  { externalRef: "first-trial", name: "First Trial (1h)", unitPriceMinor: FIRST_TRIAL_MINOR },
  ...VOUCHER_HOURS.map((hours) => ({
    externalRef: voucherItemRef(hours),
    name: `Voucher (${hours}h)`,
    unitPriceMinor: VOUCHER_PRICE[hours],
  })),
  ...PRICE_GROUPS.flatMap((group) =>
    ([1, 4, 6, 10] as const).flatMap((size) => {
      const price = CARD[group][size];
      if (price === undefined) return []; // not offered → no item → sales refuse loudly
      return [
        {
          externalRef: size === 1 ? sessionItemRef(group) : courseItemRef(group, size),
          name: size === 1 ? `Session 1h (${group})` : `Course ${size}h (${group})`,
          unitPriceMinor: price,
        },
      ];
    }),
  ),
  ...RENTAL_ITEMS, // SPEC-031 / TASK-108 — the four equipment-rental codes
];

/** Is this a product code we know how to post? Guards against a sale silently going nowhere. */
export const isKnownSaleItem = (externalRef: string): boolean =>
  SALE_ITEMS.some((i) => i.externalRef === externalRef);

export interface SellablePackage {
  priceGroup: PriceGroup;
  /** 1 = a single session; 4/6/10 = a course package. */
  size: 1 | 4 | 6 | 10;
  externalRef: string;
  priceMinor: number;
}

/**
 * The combinations that actually exist, for `GET /api/sellable-packages` — so the FE offers only what is
 * offered instead of hard-coding the card into a dropdown that will drift from it.
 */
export const sellablePackages = (): SellablePackage[] =>
  PRICE_GROUPS.flatMap((priceGroup) =>
    ([1, 4, 6, 10] as const).flatMap((size) => {
      const priceMinor = CARD[priceGroup][size];
      if (priceMinor === undefined) return [];
      return [
        {
          priceGroup,
          size,
          externalRef: size === 1 ? sessionItemRef(priceGroup) : courseItemRef(priceGroup, size),
          priceMinor,
        },
      ];
    }),
  );

/** Can this (group, size) be sold at all? Derived from the catalogue — never a second list. */
export const isSellable = (group: string | null | undefined, size: number): boolean =>
  !!group && sellablePackages().some((p) => p.priceGroup === group && p.size === size);
