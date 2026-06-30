import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as checkin from "../services/checkin.service";

const checkinBody = z.object({
  token: z.string().trim().min(8),
});

/** Public check-in (C.1) — token is the credential; no JWT. */
export const publicCheckin = new Hono().post(
  "/checkin",
  zValidator("json", checkinBody),
  async (c) => c.json(await checkin.checkinByToken(c.req.valid("json").token)),
);
