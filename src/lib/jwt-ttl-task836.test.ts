// TASK-836 (REQ-128 L1) — ONE 7-day login: the API token's default lifetime is 7 days (was 12 h); the env override `JWT_TTL_SECONDS` still wins. The guard's 401s are untouched (see middleware/auth.test.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { signToken, verifyToken } from "./jwt";

const claims = { sub: "u1", username: "ann", role: "admin" as const, isSuperAdmin: false };
const exp = async (): Promise<{ exp: number; before: number; after: number }> => {
  const before = Math.floor(Date.now() / 1000);
  const t = await signToken(claims);
  const after = Math.floor(Date.now() / 1000);
  return { exp: ((await verifyToken(t)) as any).exp, before, after };
};

let saved: { secret?: string; ttl?: string };
beforeEach(() => { saved = { secret: process.env.JWT_SECRET, ttl: process.env.JWT_TTL_SECONDS }; process.env.JWT_SECRET = "test-secret-task836"; });
afterEach(() => {
  if (saved.secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved.secret;
  if (saved.ttl === undefined) delete process.env.JWT_TTL_SECONDS; else process.env.JWT_TTL_SECONDS = saved.ttl;
});

describe("🔴 the API token lives 7 days by default", () => {
  test("env unset ⇒ exp = now + 604800 (7 × 24 × 3600), to the second", async () => {
    delete process.env.JWT_TTL_SECONDS;
    const r = await exp();
    expect(r.exp).toBeGreaterThanOrEqual(r.before + 604800);
    expect(r.exp).toBeLessThanOrEqual(r.after + 604800);
  });
  test("🔴 …and NOT 12 hours", async () => {
    delete process.env.JWT_TTL_SECONDS;
    const r = await exp();
    expect(r.exp - r.after).toBeGreaterThan(12 * 3600);
  });
  test("the env override still wins: JWT_TTL_SECONDS=3600 ⇒ exp = now + 3600; =604800 ⇒ the same as the default", async () => {
    process.env.JWT_TTL_SECONDS = "3600";
    const a = await exp();
    expect(a.exp).toBeGreaterThanOrEqual(a.before + 3600);
    expect(a.exp).toBeLessThanOrEqual(a.after + 3600);
    process.env.JWT_TTL_SECONDS = "604800";
    const b = await exp();
    expect(b.exp).toBeGreaterThanOrEqual(b.before + 604800);
    expect(b.exp).toBeLessThanOrEqual(b.after + 604800);
  });
  test("🔴 hardening — an EMPTY, garbage or ≤ 0 JWT_TTL_SECONDS falls back to 7 days (never 0, which would expire every token at once); a valid value still wins", async () => {
    for (const [v, secs] of [["", 604800], ["abc", 604800], ["0", 604800], ["-5", 604800], ["Infinity", 604800], ["3600", 3600]] as const) {
      process.env.JWT_TTL_SECONDS = v;
      const r = await exp();
      expect({ v, ok: r.exp >= r.before + secs && r.exp <= r.after + secs }).toEqual({ v, ok: true });
    }
  });
  test("the claims still round-trip (sub / username / role / isSuperAdmin) — only the lifetime changed", async () => {
    delete process.env.JWT_TTL_SECONDS;
    const c: any = await verifyToken(await signToken(claims));
    expect({ sub: c.sub, username: c.username, role: c.role, isSuperAdmin: c.isSuperAdmin }).toEqual(claims);
  });
});

describe("🔑 by source — one constant, no renewal route", () => {
  const src = readFileSync(resolve(import.meta.dir, "jwt.ts"), "utf8").replace(/\r\n/g, "\n").replace(/^\s*\/\/.*$/gm, "");
  test("the default is `7 * 24 * 3600`, read once through the env override; the file has no refresh / renew path", () => {
    expect(src).toContain("export const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;");
    expect(src).toContain("const v = Number(process.env.JWT_TTL_SECONDS);");
    expect(src).toContain("return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_SECONDS;");
    expect(src).not.toMatch(/12 \* 3600|refresh|renew/i);
  });
});
