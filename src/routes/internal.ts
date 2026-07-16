import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as jobs from "../services/jobs.service";

const endOfDayBody = z.object({
  // Optional business date (Asia/Bangkok, YYYY-MM-DD). Defaults to today. Handy for
  // re-running a day the server was down.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * Internal job trigger (UC-012). Lives OUTSIDE `/api` so it isn't JWT-guarded; the
 * shared `INTERNAL_JOB_SECRET` (x-internal-secret header) is the credential. Called
 * by the Windows Task Scheduler exe (scripts/end-of-day.ts). Disabled when the
 * secret env var is unset, so it is never an open endpoint.
 */
export const internalJobs = new Hono().post(
  "/jobs/end-of-day",
  zValidator("json", endOfDayBody),
  async (c) => {
    const secret = process.env.INTERNAL_JOB_SECRET;
    if (!secret) {
      return c.json(
        { error: { code: "NOT_CONFIGURED", message: "INTERNAL_JOB_SECRET is not set" } },
        503,
      );
    }
    if (c.req.header("x-internal-secret") !== secret) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "invalid internal secret" } }, 401);
    }
    return c.json(await jobs.runEndOfDayJob(c.req.valid("json").date));
  },
);
