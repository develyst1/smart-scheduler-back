import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import { lineWebhook } from "../routes/webhooks";

process.env.LINE_CHANNEL_SECRET = "test-secret";

const origSkip = process.env.SKIP_AUTH;
afterAll(() => {
  if (origSkip === undefined) delete process.env.SKIP_AUTH;
  else process.env.SKIP_AUTH = origSkip;
});

/** Mirrors index.ts: /api/webhooks before JWT guard. */
function makeApp() {
  const app = new Hono();
  app.route("/api/webhooks", lineWebhook);
  app.use("/api/*", authMiddleware);
  app.get("/api/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("LINE webhook route (C.4)", () => {
  test("POST /api/webhooks/line is public (no JWT) when guard enforced", async () => {
    process.env.SKIP_AUTH = "false";
    const res = await makeApp().request("/api/webhooks/line", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"events":[]}',
    });
    // No Bearer → would be UNAUTHORIZED from JWT if guard caught it; signature check runs instead.
    // 🔑 The property this test protects is WHICH refusal answers — the signature check, not the JWT guard —
    // and it is unchanged. TASK-297 only reshaped the body: `error` was a bare STRING, so a reader doing
    // `body.error.code` got `undefined`. The status stays 401 and the check itself is untouched.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("INVALID_SIGNATURE");
    expect(body.error?.message).toBe("invalid signature");
  });
});
