// TASK-371 (REQ-091 §9, Deploy A) — the pure rules of a rental ROW on a session. The service applies them; the
// tests pin them with values, without a database.

import { CALENDAR_HIDDEN_STATUSES } from "../db/schema";
import { rentalPriceList } from "./sale-items";

/**
 * The customer: *"Full Set or inline ⇒ remark required"* (which set, which pair, which size). Inline skates are
 * the RIDE item (`rental-ride` = "ride only"); a full set is `rental-set`. Helmet, pads and helmet+pads carry no
 * remark rule. ONE list, read by the service — the validator checks only the shape.
 */
export const REMARK_REQUIRED_CODES: ReadonlySet<string> = new Set(["rental-set", "rental-ride"]);
export const rentalRemarkRequired = (code: string, remark: string | null | undefined): boolean =>
  REMARK_REQUIRED_CODES.has(code) && !(remark ?? "").trim();

/**
 * No rental on a dead session: the two statuses the grid hides (`CANCELLED`, `PAUSED`). A delivered session
 * (`ATTENDED`) still accepts one — the cash is collected at the shop, sometimes after the class.
 */
export const rentalBookingLive = (status: string): boolean =>
  !(CALENDAR_HIDDEN_STATUSES as readonly string[]).includes(status);

/** The DTO shape — `null` when the session has no rental row. `paid` is `paid_at` being set, nothing else. */
export const toRentalDTO = (
  r: { code: string; remark: string | null; paidAt: Date | string | null } | null | undefined,
): { code: string; remark: string | null; paid: boolean } | null =>
  r ? { code: r.code, remark: r.remark ?? null, paid: r.paidAt != null } : null;

/**
 * TASK-373 (REQ-091 Deploy B) — the COURSE's rental, DERIVED from its rows, no column. A course rented at
 * creation carries a paid row on every live session by construction, all with one code, so "the course's
 * rental" is any of them; a course never rented has none. The reconcile copies THIS onto a later make-up
 * (its template is the leave row it replaces, which has no rental — so the course, not the template, is the
 * source), and the DTO shows it.
 */
export const courseRentalOf = (
  rows: ReadonlyArray<{ rental?: { code: string; remark: string | null } | null }>,
): { code: string; remark: string | null } | null => {
  const r = rows.find((x) => x.rental)?.rental;
  return r ? { code: r.code, remark: r.remark ?? null } : null;
};

/**
 * TASK-375 (REQ-091 Deploy B) — the customer's print shape for a rental, built ONCE on the BE:
 * `Rent {price} / {tier}` + ` ({remark})` when there is one — `Rent 200 / Full Set (inline skate size 18-19 CM)`.
 * The price is `rentalPriceList()` (the one authority); the tier words are the customer's (`§6`/`§9`), English
 * in both languages like the template labels. The FE keeps its own `rentalPrintLine` for the modal — two repos,
 * one shape, both pinned to the same example.
 */
export const RENTAL_TIER_WORDS: Record<string, string> = {
  "rental-helmet": "Helmet",
  "rental-pads": "Pad",
  "rental-helmet-pads": "Helmet + Pad",
  "rental-ride": "Ride only",
  "rental-set": "Full Set",
};
export const rentalPrintLine = (code: string, remark: string | null | undefined): string => {
  const priceMinor = rentalPriceList().find((p) => p.code === code)?.priceMinor;
  const price = priceMinor == null ? "—" : String(Math.round(priceMinor / 100));
  const line = `Rent ${price} / ${RENTAL_TIER_WORDS[code] ?? code}`;
  const r = (remark ?? "").trim();
  return r ? `${line} (${r})` : line;
};
