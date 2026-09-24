import type { Context } from "hono";
import { Hono } from "hono";
import { zValidator } from "../lib/validate";
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

// 🔴 TASK-462 — the extender's body. `apply` defaults to FALSE: a human with the secret and a curl gets the PLAN and
// nothing is written; only a caller that says `apply: true` (the nightly trigger, explicitly) writes rows.
const extenderBody = endOfDayBody.extend({
  apply: z.boolean().default(false),
  maxSeries: z.number().int().min(1).max(500).optional(),
  maxDates: z.number().int().min(1).max(5000).optional(),
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
  // TASK-441 (REQ-104 §2): the Monday 08:15 weekly coach digest — one `weekly_schedule_teacher` per teacher with a CONFIRMED
  // row in Mon–Sun, send-once per teacher per week, and it ALWAYS writes a job_runs row.
  .post("/jobs/weekly-teacher-digest", zValidator("json", endOfDayBody), async (c) => {
    const err = internalSecretError(c);
    if (err) return err;
    return c.json(await jobs.runWeeklyTeacherDigestJob(c.req.valid("json").date));
  })
  // TASK-456 (REQ-105 §3): the daily rolling extender — every NON-CLOSED group series keeps N weeks of rows ahead.
  // Idempotent by state (a second run the same day creates nothing), and it ALWAYS writes a job_runs row.
  .post("/jobs/group-series-extender", zValidator("json", extenderBody), async (c) => {
    const err = internalSecretError(c);
    if (err) return err;
    const { date, apply, maxSeries, maxDates } = c.req.valid("json");
    // 🔴 TASK-462 — two shapes, argued in the TASK:
    //  · DRY RUN (the default): synchronous, because it only READS and the human wants the answer in the response.
    //    It is bounded by the same caps as an apply, so it cannot hold the connection for long either.
    //  · APPLY: ACK with a run id and a `job_runs` row that says `running`; the work continues after the 200 and
    //    finishes that row. This route used to AWAIT the whole job — the shape TASK-460 removed from the webhook —
    //    so on `sid` "it ran long" and "the process died" were the same PowerShell error. Now they are a row that
    //    finishes and a row that never does.
    if (!apply) return c.json(await jobs.runGroupSeriesExtenderJob(date, { apply: false, maxSeries, maxDates }));
    const r = await jobs.startGroupSeriesExtenderRun(date, { maxSeries, maxDates });
    if ("alreadyRunning" in r) return c.json({ error: { code: "ALREADY_RUNNING", message: `run ${r.alreadyRunning} is still in progress` } }, 409);
    return c.json(r, 202);
  })
  // SPEC-005 / TASK-019: monthly freelance budget reset (replaces the retired ops month-start job).
  .post("/jobs/month-reset", async (c) => {
    const err = internalSecretError(c);
    if (err) return err;
    return c.json(await resetFreelanceBudgets());
  });
