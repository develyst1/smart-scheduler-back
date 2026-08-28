// Daily "class today" reminder trigger (REQ-072 3B / TASK-208) — the Windows Task Scheduler entrypoint for 08:15.
//
// This is a THIN trigger: it just POSTs the internal endpoint on the running Scheduling API. All the check +
// send + job_runs logic lives server-side (jobs.service.ts), so the exe never needs a DB connection and
// can't drift from the API's rules. Safe to re-run — the job is idempotent per business date.
//
// Build a standalone exe:
//   bun build --compile scripts/daily-reminder.ts --outfile dist/daily-reminder
// Windows Task Scheduler: run dist/daily-reminder.exe daily at 08:15, "Run whether user logged on or not".
// Set SCHEDULER_API_URL + INTERNAL_JOB_SECRET in the machine env.
//
// Env:
//   SCHEDULER_API_URL   base URL of the API (default http://localhost:4006)
//   INTERNAL_JOB_SECRET shared secret; sent as the x-internal-secret header

const base = (process.env.SCHEDULER_API_URL ?? "http://localhost:4006").replace(/\/$/, "");
const secret = process.env.INTERNAL_JOB_SECRET;

if (!secret) {
  console.error("[daily-reminder] INTERNAL_JOB_SECRET is not set — aborting");
  process.exit(2);
}

try {
  const res = await fetch(`${base}/internal/jobs/daily-reminder`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": secret },
    body: JSON.stringify({}),
  });
  const text = await res.text();
  const stamp = new Date().toISOString();
  if (!res.ok) {
    console.error(`[daily-reminder] ${stamp} FAILED ${res.status}: ${text}`);
    process.exit(1);
  }
  console.log(`[daily-reminder] ${stamp} OK: ${text}`);
} catch (err) {
  console.error(`[daily-reminder] ${new Date().toISOString()} ERROR:`, err);
  process.exit(1);
}
