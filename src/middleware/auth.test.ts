import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authMiddleware } from "./auth";
import { authRoutes } from "../routes/auth";
import { ApiException } from "../lib/http";

process.env.JWT_SECRET ??= "test-secret";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin";

// Mirrors index.ts wiring: public /api/auth/* registered BEFORE the /api guard.
function makeApp() {
  const app = new Hono();
  app.route("/api/auth", authRoutes);
  app.use("/api/*", authMiddleware);
  app.get("/api/ping", (c) => c.json({ user: c.get("user") }));
  app.onError((err, c) =>
    err instanceof ApiException
      ? c.json({ error: err.code }, err.status as any)
      : c.json({ error: "INTERNAL" }, 500),
  );
  return app;
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const origSkip = process.env.SKIP_AUTH;
afterAll(() => {
  if (origSkip === undefined) delete process.env.SKIP_AUTH;
  else process.env.SKIP_AUTH = origSkip;
});

describe("auth middleware (B.7)", () => {
  test("SKIP_AUTH=true → bypass with default admin", async () => {
    process.env.SKIP_AUTH = "true";
    const res = await makeApp().request("/api/ping");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user.role).toBe("admin");
  });

  test("enforced + no token → 401", async () => {
    process.env.SKIP_AUTH = "false";
    const res = await makeApp().request("/api/ping");
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toBe("UNAUTHORIZED");
  });

  test("invalid token → 401", async () => {
    process.env.SKIP_AUTH = "false";
    const res = await makeApp().request("/api/ping", {
      headers: { authorization: "Bearer not.a.real.jwt" },
    });
    expect(res.status).toBe(401);
  });

  test("login is public (no token) even when guard is enforced → token → access", async () => {
    process.env.SKIP_AUTH = "false";
    const app = makeApp();
    const login = await app.request(
      "/api/auth/login",
      json({ username: "admin", password: "admin" }),
    );
    expect(login.status).toBe(200); // public despite /api/* guard
    const { token, user } = (await login.json()) as any;
    expect(user).toEqual({ username: "admin", role: "admin" });

    const ping = await app.request("/api/ping", { headers: { authorization: `Bearer ${token}` } });
    expect(ping.status).toBe(200);
    expect(((await ping.json()) as any).user.sub).toBe("admin");
  });

  test("login with wrong password → 401", async () => {
    process.env.SKIP_AUTH = "false";
    const res = await makeApp().request(
      "/api/auth/login",
      json({ username: "admin", password: "nope" }),
    );
    expect(res.status).toBe(401);
  });
});
