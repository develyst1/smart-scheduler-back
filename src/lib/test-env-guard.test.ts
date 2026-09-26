// TASK-503 — the suite refuses to run against the CUSTOMER'S system (uat / the real OA), by name, never by secret; sid runs normally.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CUSTOMER_ENV, customerEnvSignals, dbHostOf, refusalMessage } from "./test-env-guard";

const root = resolve(import.meta.dir, "..", "..");
const FAKE_PW = "FAKE-PASSWORD-must-never-print";
const FAKE_TOKEN = "FAKE-TOKEN-must-never-print";
/** LIFF-shaped values are BUILT here, never written: `<channel>-` + a fake suffix (no LIFF id literal in src — liff-link-req107). */
const liffOf = (channel: string) => `${channel}-${"x".repeat(8)}`;
/** sid's non-secret identifiers (owner's `.env.sid`), with FAKE secrets. */
const SID = { DATABASE_URL: `postgres://app:${FAKE_PW}@154.197.124.206:5432/smart_scheduler`, LINE_OA_WRITE_ALLOW: "@125vuzsj", LIFF_ID: liffOf("2011571495"), LINE_LOGIN_CHANNEL_ID: "2011571495", LINE_CHANNEL_ACCESS_TOKEN: FAKE_TOKEN };

describe("✅ sid and local pass untouched", () => {
  test("sid's values ⇒ no signal · a local database ⇒ no signal · nothing set ⇒ no signal", () => {
    expect(customerEnvSignals(SID)).toEqual([]);
    expect(customerEnvSignals({ DATABASE_URL: "postgres://u:p@localhost:5432/test" })).toEqual([]);
    expect(customerEnvSignals({})).toEqual([]);
  });
  test("🔑 THIS run's own environment passes (the suite is running under the guard right now)", () => {
    expect(customerEnvSignals(process.env)).toEqual([]);
  });
});

describe("🔴 each customer signal ALONE refuses — by name", () => {
  test("the uat database host · the real OA (even inside a list) · the real LIFF · the real login channel", () => {
    expect(customerEnvSignals({ ...SID, DATABASE_URL: `postgres://app:${FAKE_PW}@154.197.124.29:5432/smart_scheduler` }).map((s) => s.setting)).toEqual(["DATABASE_URL"]);
    expect(customerEnvSignals({ ...SID, LINE_OA_WRITE_ALLOW: "@125vuzsj, @427ybeky" }).map((s) => s.setting)).toEqual(["LINE_OA_WRITE_ALLOW"]);
    expect(customerEnvSignals({ ...SID, LIFF_ID: liffOf("2011577840") }).map((s) => s.setting)).toEqual(["LIFF_ID"]);
    expect(customerEnvSignals({ ...SID, LINE_LOGIN_CHANNEL_ID: "2011577840" }).map((s) => s.setting)).toEqual(["LINE_LOGIN_CHANNEL_ID"]);
    expect(CUSTOMER_ENV).toEqual({ dbHosts: ["154.197.124.29"], oaIds: ["@427ybeky"], loginChannelIds: ["2011577840"] });
  });
  test("a FULL uat .env shape ⇒ all four, in one message", () => {
    const uat = { DATABASE_URL: `postgres://app:${FAKE_PW}@154.197.124.29:5432/smart_scheduler`, LINE_OA_WRITE_ALLOW: "@427ybeky", LIFF_ID: liffOf("2011577840"), LINE_LOGIN_CHANNEL_ID: "2011577840", LINE_CHANNEL_ACCESS_TOKEN: FAKE_TOKEN };
    expect(customerEnvSignals(uat).map((s) => s.setting)).toEqual(["DATABASE_URL", "LINE_OA_WRITE_ALLOW", "LIFF_ID", "LINE_LOGIN_CHANNEL_ID"]);
  });
});

describe("🔑 by NAME, never by secret — no credential is compared, returned or printed", () => {
  test("`dbHostOf` returns the host and nothing else (not the user, password, port or database)", () => {
    expect(dbHostOf(`postgres://app:${FAKE_PW}@154.197.124.29:5432/smart_scheduler`)).toBe("154.197.124.29");
    expect(dbHostOf("not a url")).toBeNull();
    expect(dbHostOf(undefined)).toBeNull();
  });
  test("the message names each tripped SETTING, says to switch back to sid, and contains no password, token or URL", () => {
    const uat = { DATABASE_URL: `postgres://app:${FAKE_PW}@154.197.124.29:5432/smart_scheduler`, LINE_OA_WRITE_ALLOW: "@427ybeky", LINE_CHANNEL_ACCESS_TOKEN: FAKE_TOKEN };
    const msg = refusalMessage(customerEnvSignals(uat));
    expect(msg).toContain("DATABASE_URL → host 154.197.124.29");
    expect(msg).toContain("LINE_OA_WRITE_ALLOW → @427ybeky");
    expect(msg).toContain("switch .env back to the sid values");
    expect(msg).toContain("NOTHING has connected");
    expect(msg).not.toContain(FAKE_PW);
    expect(msg).not.toContain(FAKE_TOKEN);
    expect(msg).not.toContain("postgres://");
  });
});

describe("🔴 by BEHAVIOUR — a real `bun test` of ONE file, with a uat-shaped environment, is refused before any test runs", () => {
  test("refused · no test ran · nothing secret echoed (the preload runs for single-file runs too)", () => {
    const r = spawnSync("bun", ["test", "src/lib/crm.test.ts"], {
      cwd: root, encoding: "utf8", timeout: 60_000, shell: process.platform === "win32",
      env: { ...process.env, DATABASE_URL: `postgres://app:${FAKE_PW}@154.197.124.29:5432/smart_scheduler`, LINE_OA_WRITE_ALLOW: "@427ybeky", LINE_CHANNEL_ACCESS_TOKEN: FAKE_TOKEN },
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status).not.toBe(0);
    expect(out).toContain("REFUSING TO RUN THE TESTS");
    expect(out).not.toMatch(/\b5 pass\b/); // crm.test.ts's five tests never ran
    expect(out).not.toContain(FAKE_PW);
    expect(out).not.toContain(FAKE_TOKEN);
  });
});

describe("🔑 wired, and no way round it (by source)", () => {
  test("`bunfig.toml` preloads the guard; the preload imports NO app code and reads no switch that could skip it", () => {
    expect(readFileSync(resolve(root, "bunfig.toml"), "utf8")).toMatch(/\[test\]\s*\npreload = \["\.\/src\/test-env-guard\.preload\.ts"\]/);
    const P = readFileSync(resolve(root, "src/test-env-guard.preload.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    // EVERY import, side-effect ones included (`import "./db";` has no `from` — break-and-watch E found the first version blind to it)
    expect([...P.matchAll(/\bimport\s+(?:[^"';]*?\bfrom\s+)?["']([^"']+)["']/g)].map((m) => m[1])).toEqual(["./lib/test-env-guard"]);
    expect(P).not.toMatch(/\bimport\s*\(/); // …and no dynamic import
    expect(P).toContain("if (signals.length) throw new Error(refusalMessage(signals));");
    const G = readFileSync(resolve(root, "src/lib/test-env-guard.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(G).not.toContain("process.env"); // the rules read only the env they are HANDED — no switch of their own to flip
    expect(G).not.toMatch(/LINE_CHANNEL_ACCESS_TOKEN|PASSWORD|SECRET/); // the guard never even names a credential
  });
});
