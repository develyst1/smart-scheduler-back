import { Hono } from "hono";
import { zValidator } from "../lib/validate";
import { z } from "zod";
import * as checkin from "../services/checkin.service";
import * as camp from "../services/camp.service";
import * as shopfront from "../services/shopfront-checkin.service";
import { ApiException } from "../lib/http";
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
const RATE_LIMITED = () => new ApiException(429, "RATE_LIMITED", "กรุณาลองใหม่อีกครั้งในอีกสักครู่ หรือติดต่อเคาน์เตอร์ / Please try again shortly or ask the front desk");
const ipOf = (c: any) => clientIp(c.req.header("x-forwarded-for"), c.req.header("cf-connecting-ip"));

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
  .post("/checkin/shopfront", zValidator("json", shopfrontCheckinBody), async (c) => {
    const ip = ipOf(c), now = Date.now();
    if (shopfrontRateLimit.blocked(ip, now)) throw RATE_LIMITED();
    try {
      const out = await shopfront.shopfrontCheckin(c.req.valid("json"));
      shopfrontRateLimit.record(ip, now, false);
      return c.json(out);
    } catch (e: any) {
      shopfrontRateLimit.record(ip, now, e?.code === "NOT_CHECKINABLE"); // an id not in the phone's list is a miss
      throw e;
    }
  });
