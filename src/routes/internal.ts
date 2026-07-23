import type { Context } from "hono";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as jobs from "../services/jobs.service";
import { resetFreelanceBudgets } from "../services/scheduler.service";

const endOfDayBody = z.object({
  // Optional business date (Asia/Bangkok, YYYY-MM-DD). Defaults to today. Handy for
  // re-running a day the server was down.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** Shared `INTERNAL_JOB_SECRET` gate (x-internal-secret header). Returns an error Response to send,
 *  or null to proceed. Disabled (503) when the secret is unset → never an open endpoint. */
function internalSecretError(c: Context): Response | null {
  const secret = process.env.INTERNAL_JOB_SECRET;
  if (!secret)
    return c.json(
      { error: { code: "NOT_CONFIGURED", message: "INTERNAL_JOB_SECRET is not set" } },
      503,
    );
  if (c.req.header("x-internal-secret") !== secret)
    return c.json({ error: { code: "UNAUTHORIZED", message: "invalid internal secret" } }, 401);
  return null;
}

/**
 * Internal job triggers. Live OUTSIDE `/api` so they aren't JWT-guarded; the shared
 * `INTERNAL_JOB_SECRET` is the credential. Called by the Windows Task Scheduler exes.
 */
export const internalJobs = new Hono()
  .post("/jobs/end-of-day", zValidator("json", endOfDayBody), async (c) => {
    const err = internalSecretError(c);
    if (err) return err;
    return c.json(await jobs.runEndOfDayJob(c.req.valid("json").date));
  })
  // SPEC-005 / TASK-019: monthly freelance budget reset (replaces the retired ops month-start job).
  .post("/jobs/month-reset", async (c) => {
    const err = internalSecretError(c);
    if (err) return err;
    return c.json(await resetFreelanceBudgets());
  });
