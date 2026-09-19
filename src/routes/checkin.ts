import { Hono } from "hono";
import { zValidator } from "../lib/validate";
import { z } from "zod";
import * as checkin from "../services/checkin.service";
import * as camp from "../services/camp.service";

const checkinBody = z.object({
  token: z.string().trim().min(8),
});

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
  .post("/checkin/camp", zValidator("json", checkinBody), async (c) => c.json(await camp.checkinCampByToken(c.req.valid("json").token)));
