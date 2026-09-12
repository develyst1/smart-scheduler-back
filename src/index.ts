import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { api } from "./routes/api";
import { ApiException, pgErrorCode } from "./lib/http";
import { startOutboxWorker } from "./services/outbox.service";
import { authMiddleware } from "./middleware/auth";
import { authRoutes } from "./routes/auth";
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
startOutboxWorker();

app.get("/health", async (c) => {
  const r = await db.execute(sql`select 1 as ok`);
  return c.json({ ok: true, db: r[0]?.ok === 1 });
});

// API docs (Swagger UI) — public
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
  if (err instanceof ApiException) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status as any,
    );
  }
  const code = pgErrorCode(err);
  if (code === "23505") {
    return c.json({ error: { code: "SLOT_TAKEN", message: "มีคาบในช่วงเวลานี้แล้ว" } }, 409);
  }
  if (code === "23503") {
    return c.json({ error: { code: "VALIDATION", message: "ข้อมูลอ้างอิงไม่ถูกต้อง" } }, 400);
  }
  console.error(err);
  return c.json({ error: { code: "INTERNAL", message: "เกิดข้อผิดพลาดภายในระบบ" } }, 500);
});

export type AppType = typeof routes;

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
};
