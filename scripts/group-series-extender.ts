// TASK-456 (REQ-105 §3) — the ROLLING EXTENDER trigger: the Windows Task Scheduler entrypoint, daily at 03:30.
//
// This is a THIN trigger: it just POSTs the internal endpoint on the running Scheduling API. All the check +
// create + job_runs logic lives server-side (jobs.service.ts), so the exe never needs a DB connection and
// cannot drift from the API's rules. Safe to re-run — the job is idempotent BY STATE, so a second run creates nothing.
//
// Build a standalone exe:
//   bun build --compile scripts/group-series-extender.ts --outfile dist/group-series-extender
// Windows Task Scheduler: run dist/group-series-extender.exe daily at 03:30, "Run whether user logged on or not".
// Set SCHEDULER_API_URL + INTERNAL_JOB_SECRET in the machine env.
//
// Env:
//   SCHEDULER_API_URL   base URL of the API (default http://localhost:4006)
//   INTERNAL_JOB_SECRET shared secret; sent as the x-internal-secret header

const base = (process.env.SCHEDULER_API_URL ?? "http://localhost:4006").replace(/\/$/, "");
const secret = process.env.INTERNAL_JOB_SECRET;

if (!secret) {
  console.error("[group-series-extender] INTERNAL_JOB_SECRET is not set — aborting");
  process.exit(2);
}

try {
  const res = await fetch(`${base}/internal/jobs/group-series-extender`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": secret },
    body: JSON.stringify({}),
  });
  const text = await res.text();
  const stamp = new Date().toISOString();
  if (!res.ok) {
    console.error(`[group-series-extender] ${stamp} FAILED ${res.status}: ${text}`);
    process.exit(1);
  }
  console.log(`[group-series-extender] ${stamp} OK: ${text}`);
} catch (err) {
  console.error(`[group-series-extender] ${new Date().toISOString()} ERROR:`, err);
  process.exit(1);
}
