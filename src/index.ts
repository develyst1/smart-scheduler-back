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

const app = new Hono();

app.use("*", cors()); // dev: allow all. Lock to the Next.js origin in prod.

// Start the LINE outbox delivery worker (idle if LINE isn't configured).
startOutboxWorker();

app.get("/health", async (c) => {
  const r = await db.execute(sql`select 1 as ok`);
  return c.json({ ok: true, db: r[0]?.ok === 1 });
});

// Public auth endpoints under /api (so one reverse-proxy rule `/api → BE` covers
// them). Registered BEFORE the guard so the JWT middleware does not wrap them.
app.route("/api/auth", authRoutes);
app.route("/webhooks", lineWebhook);
app.route("/api", publicCheckin);

// Everything else under /api requires a valid JWT (bypassed when SKIP_AUTH=true).
app.use("/api/*", authMiddleware);

// Mount the scheduling API. `routes` carries the type for the FE's hc<AppType>.
const routes = app.route("/api", api);

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
