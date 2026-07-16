// End-of-day auto-cut trigger (UC-012) — the Windows Task Scheduler entrypoint.
//
// This is a THIN trigger: it just POSTs the internal endpoint on the running
// Scheduling API. All the cut + report logic lives server-side (jobs.service.ts),
// so the exe never needs a DB connection and can't drift from the API's rules.
//
// Build a standalone exe:
//   bun build --compile scripts/end-of-day.ts --outfile dist/end-of-day
// Windows Task Scheduler: run dist/end-of-day.exe daily ~18:05, "Run whether user
// logged on or not". Set SCHEDULER_API_URL + INTERNAL_JOB_SECRET in the machine env.
//
// Env:
//   SCHEDULER_API_URL   base URL of the API (default http://localhost:3001)
//   INTERNAL_JOB_SECRET shared secret; sent as the x-internal-secret header

const base = (process.env.SCHEDULER_API_URL ?? "http://localhost:3001").replace(/\/$/, "");
const secret = process.env.INTERNAL_JOB_SECRET;

if (!secret) {
  console.error("[end-of-day] INTERNAL_JOB_SECRET is not set — aborting");
  process.exit(2);
}

try {
  const res = await fetch(`${base}/internal/jobs/end-of-day`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": secret },
    body: JSON.stringify({}),
  });
  const text = await res.text();
  const stamp = new Date().toISOString();
  if (!res.ok) {
    console.error(`[end-of-day] ${stamp} FAILED ${res.status}: ${text}`);
    process.exit(1);
  }
  console.log(`[end-of-day] ${stamp} OK: ${text}`);
} catch (err) {
  console.error(`[end-of-day] ${new Date().toISOString()} ERROR:`, err);
  process.exit(1);
}
