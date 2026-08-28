import type { Context } from "hono";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as jobs from "../services/jobs.service";
import * as attention from "../services/attention.service";
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
  // REQ-023 / TASK-053: 08:00 attention digest — one LINE message to admins, silent when everything is clear,
  // idempotent per business date, and it ALWAYS writes a job_runs row so "never ran" stays visible.
  .post("/jobs/daily-digest", zValidator("json", endOfDayBody), async (c) => {
    const err = internalSecretError(c);
    if (err) return err;
    return c.json(await attention.runDailyDigestJob(c.req.valid("json").date));
  })
  // SPEC-066 / TASK-208 (REQ-072 3B): 08:15 "class today" push — one message per PERSON (teacher + parent),
  // idempotent per business date, and it ALWAYS writes a job_runs row so a job that was never registered on
  // the box stays visible instead of failing silently for weeks.
  .post("/jobs/daily-reminder", zValidator("json", endOfDayBody), async (c) => {
    const err = internalSecretError(c);
    if (err) return err;
    return c.json(await jobs.runDailyReminderJob(c.req.valid("json").date));
  })
  // SPEC-005 / TASK-019: monthly freelance budget reset (replaces the retired ops month-start job).
  .post("/jobs/month-reset", async (c) => {
    const err = internalSecretError(c);
    if (err) return err;
    return c.json(await resetFreelanceBudgets());
  });
