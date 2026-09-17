// TASK-371 (REQ-091 §9, Deploy A) — the pure rules of a rental ROW on a session. The service applies them; the
// tests pin them with values, without a database.

import { CALENDAR_HIDDEN_STATUSES } from "../db/schema";

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
