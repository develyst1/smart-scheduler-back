// TASK-375 (REQ-091 Deploy B) — "did the daily reminder already run today?", extracted from `jobs.service.ts`
// so a second reader can ask it without closing an import cycle (`jobs.service` → `scheduler.service` →
// `rental.service` → back). The read is the ORIGINAL, byte for byte: a `job_runs` row for the job on that
// date whose summary says `attempted`.
//
// ⚠️ Recorded, not acted on, in the job itself (see `runDailyReminderJob`'s note — never re-wire it into an
// `if` around the send). Its ONE acting reader is the same-day rental notice: a rental added after the
// reminder went is the case the reminder cannot carry, so the coach is told separately — and only then.

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { jobRuns } from "../db/schema";

export const REMINDER_JOB = "daily-reminder";

export async function reminderRanOn(runDate: string, exec: any = db): Promise<boolean> {
  const rows = await exec
    .select()
    .from(jobRuns)
    .where(and(eq(jobRuns.job, REMINDER_JOB), eq(jobRuns.runDate, runDate)));
  // 🔴 TASK-209: keyed on `attempted`, NOT on `sent`. `sent` is a delivered COUNT, and a day where every
  // recipient was unlinked delivers 0 — reading this off that number would misreport a day that reached
  // nobody as one that never fired.
  return rows.some((r: any) => (r.summary as any)?.attempted === true);
}
