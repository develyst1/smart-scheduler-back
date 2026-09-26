import { Hono } from "hono";
import { zValidator } from "../lib/validate";
import { z } from "zod";
import * as checkin from "../services/checkin.service";
import * as camp from "../services/camp.service";
import * as shopfront from "../services/shopfront-checkin.service";
import { ApiException, errorEnvelope } from "../lib/http";
import { isPhoneShaped } from "../services/parent.service";
import { clientIp, shopfrontRateLimit } from "../lib/shopfront-rate-limit";

const checkinBody = z.object({
  token: z.string().trim().min(8),
});

// TASK-475 (REQ-108) — the shop-front QR. A body that is not phone-shaped is a 400 (it reveals nothing about customers);
// every well-formed phone gets the same shape back, match or not.
const phoneField = z.string().trim().refine(isPhoneShaped, "เบอร์โทรไม่ถูกต้อง");
const shopfrontLookupBody = z.object({ phone: phoneField });
const shopfrontCheckinBody = z
  .object({ phone: phoneField, bookingId: z.string().uuid().optional(), campDayId: z.string().uuid().optional() })
  .refine((b) => !!b.bookingId !== !!b.campDayId, "ต้องระบุ bookingId หรือ campDayId อย่างใดอย่างหนึ่ง");
/**
 * TASK-490 — the most items one batch may carry. The page can only offer what the lookup returned: the family's children
 * with something check-in-able NOW (a session or a camp half-day each). 10 is well above any real family's "now" and keeps
 * one request's work bounded (each item is one lookup + one act).
 */
export const SHOPFRONT_BATCH_MAX = 10;
const shopfrontItem = z
  .object({ bookingId: z.string().uuid().optional(), campDayId: z.string().uuid().optional() })
  .refine((b) => !!b.bookingId !== !!b.campDayId, "ต้องระบุ bookingId หรือ campDayId อย่างใดอย่างหนึ่ง");
const shopfrontBatchBody = z
  .object({ phone: phoneField, items: z.array(shopfrontItem).min(1).max(SHOPFRONT_BATCH_MAX) })
  .refine((b) => new Set(b.items.map((i) => i.bookingId ?? i.campDayId)).size === b.items.length, "รายการซ้ำ / duplicate item");
const RATE_LIMITED = () => new ApiException(429, "RATE_LIMITED", "กรุณาลองใหม่อีกครั้งในอีกสักครู่ หรือติดต่อเคาน์เตอร์ / Please try again shortly or ask the front desk");
const ipOf = (c: any) => clientIp(c.req.header("x-forwarded-for"), c.req.header("cf-connecting-ip"));

/**
 * 🔑 TASK-490 — THE shop-front check-in as ONE request: the limiter asked BEFORE the work, the act (`shopfrontCheckin`:
 * re-validated against the phone's CURRENT list, then the same act as every other door), the limiter told AFTER. The single
 * route runs it once; the batch runs it once PER ITEM. So a batch is N of exactly this and nothing else — it cannot check in
 * anything a single request would refuse, and it costs the limiter exactly what N single requests cost (a batch is no way
 * round the limit: past the limit, the rest of the batch is refused item by item, as N requests would be).
 */
async function shopfrontCheckinOne(ip: string, input: { phone: string; bookingId?: string; campDayId?: string }) {
  const now = Date.now();
  if (shopfrontRateLimit.blocked(ip, now)) throw RATE_LIMITED();
  try {
    const out = await shopfront.shopfrontCheckin(input);
    shopfrontRateLimit.record(ip, now, false);
    return out;
  } catch (e: any) {
    shopfrontRateLimit.record(ip, now, e?.code === "NOT_CHECKINABLE"); // an id not in the phone's list is a miss
    throw e;
  }
}

/**
 * Public check-in (C.1) — token is the credential; no JWT.
 *
 * TASK-403: `POST /checkin/camp` beside it — a CAMP DAY's scan (`lib/camp.ts` `campScanOutcome`). ⚠️ TWO ROUTES, TWO
 * CODES, ON PURPOSE: the session route keeps its `400` for an expired token (its page is live and unchanged); the camp
 * route answers `410 CAMP_TOKEN_EXPIRED`, `409 CAMP_DAY_NOT_TODAY` (a scan on another date), `409 CAMP_DAY_TRANSITION`
 * (a CANCELLED day), `404` (unknown), and `{ already: true }` on a second scan. No CRM points.
 */
export const publicCheckin = new Hono()
  .post("/checkin", zValidator("json", checkinBody), async (c) => c.json(await checkin.checkinByToken(c.req.valid("json").token)))
  .post("/checkin/camp", zValidator("json", checkinBody), async (c) => c.json(await camp.checkinCampByToken(c.req.valid("json").token)))
  // 🔴 TASK-475 (REQ-108) — the shop-front QR. Public; the phone is the only credential; rate-limited per IP on MISSES.
  .post("/checkin/shopfront/lookup", zValidator("json", shopfrontLookupBody), async (c) => {
    const ip = ipOf(c), now = Date.now();
    if (shopfrontRateLimit.blocked(ip, now)) throw RATE_LIMITED();
    const out = await shopfront.shopfrontLookup(c.req.valid("json").phone);
    shopfrontRateLimit.record(ip, now, out.children.length === 0);
    return c.json(out);
  })
  .post("/checkin/shopfront", zValidator("json", shopfrontCheckinBody), async (c) => c.json(await shopfrontCheckinOne(ipOf(c), c.req.valid("json"))))
  // 🔴 TASK-490 — several children in one go. ONE RESULT PER ITEM, in the order asked, each `{ …the item, status, body }` where
  // status + body are EXACTLY what the single route answers for that item (success: its body; refusal: `errorEnvelope`, the
  // same function as `app.onError`). Partial success is normal: 🚫 never all-or-nothing (a refused child does not undo or block
  // the others — each act is its own transaction, and a batch is NOT one), 🚫 never one overall outcome. The request itself
  // answers 200 once it has been read; the outcomes are in the rows.
  .post("/checkin/shopfront/batch", zValidator("json", shopfrontBatchBody), async (c) => {
    const ip = ipOf(c), { phone, items } = c.req.valid("json");
    const results: Array<{ bookingId?: string; campDayId?: string; status: number; body: unknown }> = [];
    for (const item of items) { // in order, one at a time: each child decided on its own, never in parallel with another
      try {
        results.push({ ...item, status: 200, body: await shopfrontCheckinOne(ip, { phone, ...item }) });
      } catch (e) {
        results.push({ ...item, ...errorEnvelope(e) });
      }
    }
    return c.json({ results });
  });
