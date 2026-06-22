import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "./db";

const app = new Hono();

app.get("/health", async (c) => {
  const r = await db.execute(sql`select 1 as ok`);
  return c.json({ ok: true, db: r[0]?.ok === 1 });
});

// TODO: mount routes/* — calendar, teachers, courses, bookings, reports.
// See src/types/contract.ts for the request/response shapes.

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
};
