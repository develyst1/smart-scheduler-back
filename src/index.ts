import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { api } from "./routes/api";
import { errorEnvelope } from "./lib/http";
import { startOutboxWorker } from "./services/outbox.service";
import { authMiddleware, accessGuard } from "./middleware/auth";
import { coachRateMask } from "./middleware/coach-rate-mask";
import { uuidParamGuard } from "./middleware/uuid-params";
import { authRoutes } from "./routes/auth";
import { userRoutes } from "./routes/users";
import { meRoutes } from "./routes/me";
import { permissionRoutes } from "./routes/permissions";
import { roleRoutes } from "./routes/roles";
import { campRoutes } from "./routes/camp";
import { lineWebhook } from "./routes/webhooks";
import { publicCheckin } from "./routes/checkin";
import { publicCalendar } from "./routes/calendar";
import { publicRegister } from "./routes/register";
import { internalJobs } from "./routes/internal";
import { apiDocs, rootDocs } from "./routes/docs";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*", // dev: allow all. Lock to the Next.js frontoffice origin in prod.
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
); // explicit methods so PATCH passes preflight even on older Hono builds

// Start the LINE outbox delivery worker (idle if LINE isn't configured).
// 🔴 TASK-505 — ONLY when this file is the process ENTRY: `bun src/index.ts` (start), `bun --watch src/index.ts` (dev) and the
// compiled binary (`bun build src/index.ts --compile`) — all three verified to report `import.meta.main === true`. A TEST only ever
// IMPORTS the app (~25 files do), where it is `false` — so a test run no longer becomes a second outbox worker that reads the
// outbox and DELIVERS its pending LINE rows with whatever token `.env` holds. No env var decides it: nothing to forget to set.
if (import.meta.main) startOutboxWorker();

// 🔴 TASK-462 — the process must SURVIVE a database blip. On 2026-09-24 the shared Postgres cluster on `sid` went into
// recovery (`57P03`) and every in-flight query rejected at once. A rejection nobody awaited used to TERMINATE the
// process (Bun follows Node), so a hiccup on a box hosting ~30 apps could take this API down for reasons that have
// nothing to do with us — and it would happen again next week.
//
// ⚖️ The two events are deliberately NOT treated alike:
//  · `unhandledRejection` — async work that failed; its stack unwound normally and nothing is half-written in memory.
//    Log it WITH the reason and keep serving. A DB blip is exactly this, many times over.
//  · `uncaughtException` — a SYNCHRONOUS throw that escaped to the top: state is genuinely unknown (Node's own guidance
//    is never to resume). Log it, then exit(1) so a supervisor restarts us clean — 📌 on `som-back` that supervisor is
//    PM2 (fork mode, ONE process — Porter, TASK-463), so exit(1) there means "restarted", not "down". Never worse than before:
//    without a handler the process already died here — this adds the line saying why.
// 🚫 Neither handler may swallow silently, neither may exit(0) (a supervisor would read a crash as a clean stop), and
// neither answers a request — they are last-resort logs, not error handling.
// 🔴 TASK-506 — the SERVER's crash policy, so it is INSTALLED only when this file is the process entry (the same
// `import.meta.main` rule as the outbox worker, TASK-505): a test IMPORTS the app, and there an uncaught throw must fail
// the test that caused it — not `exit(1)` the whole run. The handlers are exported so their behaviour stays testable
// by value; what they DO is unchanged.
export const onUnhandledRejection = (reason: unknown) => {
  console.error("[process] unhandledRejection — logged, still serving:", reason);
};
export const onUncaughtException = (err: unknown) => {
  console.error("[process] uncaughtException — state unknown, exiting(1) for a clean restart:", err);
  process.exit(1);
};
if (import.meta.main) {
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
}

app.get("/health", async (c) => {
  const r = await db.execute(sql`select 1 as ok`);
  return c.json({ ok: true, db: r[0]?.ok === 1 });
});

// API docs (Swagger UI) — 🔴 PUBLIC ON PURPOSE: ANOTHER TEAM USES THEM (owner's ruling, 2026-09-26 — TASK-509). Do not put them
// behind the guards to "fix" them: that breaks a consumer you cannot see from this file. Closing them is the owner's call.
// What they expose, as walked (TASK-509) — not a reassurance:
// · `openapi.json` — a HAND-WRITTEN, PARTIAL schema (`openapi/document.ts`: 17 paths of the ~130 guarded routes, 7 schemas):
//   route names, request/response shapes, the bearer-token scheme. No customer data, no host, no coach-rate field. Its login
//   example is `admin` / `admin` — the bootstrap username of `.env.example`; the password cannot be set (8+ chars required).
// · `docs` — the Swagger UI page for that document; its script and style load from cdn.jsdelivr.net (the package default).
// Both are mounted TWICE: under `/api` (the reverse proxy's) and at the root (a direct hit on the Bun port).
app.route("/", rootDocs);
app.route("/api", apiDocs);

// Public routes under /api — registered BEFORE JWT guard (reverse proxy: /api → BE).
app.route("/api/auth", authRoutes);
app.route("/api/webhooks", lineWebhook); // POST /api/webhooks/line (LINE Developers URL)
app.route("/api", publicCheckin);
app.route("/api", publicCalendar); // GET /api/calendar/<token>.ics — token is the credential (REQ-017)
app.route("/api", publicRegister); // POST /api/register/{lookup,link,create} — the LIFF ID token is the credential (REQ-088, TASK-347)
// Legacy path without /api prefix (direct to BE port, local tunnel, etc.)
app.route("/webhooks", lineWebhook);
// Internal job trigger (UC-012) — secret-guarded, not JWT. Called by Task Scheduler exe.
app.route("/internal", internalJobs);

// Everything else under /api requires a valid JWT (bypassed when SKIP_AUTH=true).
app.use("/api/*", authMiddleware);
app.use("/api/*", accessGuard);
app.use("/api/*", uuidParamGuard); // TASK-450 — a malformed `:id` is a 400 at the boundary, never a `22P02` from the DB
app.use("/api/*", coachRateMask); // TASK-431 — the ONE read seam for the §13.3 coach rate (key 59): nulls `rate` / `classRateMinor` for a viewer without it // TASK-381/385 — ONE guard (menu, then action), driven by `lib/route-access.ts`; fails closed on an unmapped route
app.route("/api/users", userRoutes); // TASK-377 — super admin only (its own middleware), behind the guard
app.route("/api/me", meRoutes); // TASK-383 — the signed-in user's own routes, behind the JWT guard, not menu-gated
app.route("/api/permissions", permissionRoutes); // TASK-385 — the key registry with labels, any signed-in user
app.route("/api/roles", roleRoutes); // TASK-387 — super admin only (its own middleware), behind the guard
app.route("/api/camp", campRoutes); // TASK-401 — Balance camp, behind the guard; the access table gates it

// Mount the scheduling API. `routes` carries the type for the FE's hc<AppType>.
const routes = app.route("/api", api);

// 🔴 TASK-297 — there was no `notFound` handler at all, so an unknown path answered with Hono's
// plain-text `404 Not Found`. **A client calling `res.json()` on that gets a parse error, not an envelope** —
// the failure reads as a broken server rather than a wrong URL.
//
// 🔑 It is the same shape as DEF-5 and it is the reason this one is worth fixing: `onError` exists, is
// correct, and **is not on this path** — a 404 is not a thrown error, so nothing ever routed here.
// 📌 Read by a developer typo or a stale client, never by an admin, so the message is English and short.
app.notFound((c) =>
  c.json({ error: { code: "NOT_FOUND", message: "route not found" } }, 404),
);

app.onError((err, c) => {
  // TASK-490 — the mapping lives in `errorEnvelope` (lib/http.ts), shared with the shop-front batch's per-item results.
  const { status, body } = errorEnvelope(err);
  return c.json(body, status as any);
});

export type AppType = typeof routes;

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
};
