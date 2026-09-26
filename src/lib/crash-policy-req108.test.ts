// TASK-506 — the server's crash policy (TASK-462) is installed on a REAL boot and never in a test process. Pinned by BEHAVIOUR:
//  · a real `bun src/index.ts` (with a probe preloaded that raises a rejection, then an uncaught throw) LOGS the rejection and keeps
//    running, then LOGS the throw and exits 1 — exactly TASK-462's policy. Without the policy installed, the process would die at the
//    rejection with none of those lines. 🔒 Closed database, fake LINE token: the boot can reach nothing and send nothing.
//  · a test process that imports the app has NONE of the policy's listeners — so an uncaught throw fails the test that caused it,
//    instead of `exit(1)`-ing the whole run.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const SAFE = { ...process.env, DATABASE_URL: "postgres://x:x@127.0.0.1:1/closed", LINE_CHANNEL_ACCESS_TOKEN: "FAKE-token-for-a-crash-probe", PORT: "0" };

describe("🔴 the crash policy — on a real boot, and never under test", () => {
  test("🔑 PRODUCTION unchanged, by value: a real entry LOGS a rejection and SURVIVES it, then LOGS an uncaught throw and EXITS 1", async () => {
    const p = Bun.spawn(["bun", "--preload", "./src/test-support/crash-probe.preload.ts", "src/index.ts"], { cwd: root, env: SAFE, stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => p.kill(), 20_000); // a policy that never exits must not hang the suite
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(killer);
    const all = out + err;
    const rejected = all.indexOf("[process] unhandledRejection — logged, still serving:");
    const thrown = all.indexOf("[process] uncaughtException — state unknown, exiting(1) for a clean restart:");
    expect(rejected).toBeGreaterThanOrEqual(0);
    expect(all).toContain("probe-rejection");
    expect(thrown).toBeGreaterThan(rejected); // it SURVIVED the rejection, and only the throw ended it
    expect(all).toContain("probe-uncaught");
    expect(code).toBe(1); // never 0 — a supervisor must read it as a crash
  }, 30_000);
  test("🔴 a TEST process that imports the app has NONE of the policy's listeners", async () => {
    await import("../index");
    const mine = (event: "uncaughtException" | "unhandledRejection") => process.listeners(event).filter((l) => /state unknown|still serving/.test(String(l)));
    expect(mine("uncaughtException")).toEqual([]);
    expect(mine("unhandledRejection")).toEqual([]);
  });
  test("by source: the ONE install is guarded by `import.meta.main`", async () => {
    const I = (await Bun.file(resolve(root, "src/index.ts")).text()).replace(/\r\n/g, "\n").replace(/^\s*\/\/.*$/gm, "");
    expect(I).toContain('if (import.meta.main) {\n  process.on("unhandledRejection", onUnhandledRejection);\n  process.on("uncaughtException", onUncaughtException);\n}');
    expect(I.match(/process\.on\(/g)?.length).toBe(2);
  });
});
