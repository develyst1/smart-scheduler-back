// TASK-505 — the LINE outbox worker starts on a REAL boot and never in a test process — pinned by BEHAVIOUR, as real processes.
// 🔒 Both runs are made harmless before they start: the database is a CLOSED local port and the LINE token is a FAKE, so even a
// broken guard could reach nothing and send nothing. What is observed is only the worker's own start line.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const SAFE = { ...process.env, DATABASE_URL: "postgres://x:x@127.0.0.1:1/closed", LINE_CHANNEL_ACCESS_TOKEN: "FAKE-token-for-a-start-probe", PORT: "0" };

/** Run a process until its output contains `until` (or the time runs out), then stop it. Returns everything it printed. */
async function runUntil(cmd: string[], until: RegExp, ms: number): Promise<string> {
  const p = Bun.spawn(cmd, { cwd: root, env: SAFE, stdout: "pipe", stderr: "pipe" });
  let out = "";
  const pump = async (s: ReadableStream<Uint8Array>) => { const r = s.getReader(); const d = new TextDecoder(); for (;;) { const { value, done } = await r.read(); if (done) break; out += d.decode(value); } };
  const reading = Promise.all([pump(p.stdout), pump(p.stderr)]);
  const deadline = Date.now() + ms;
  while (!until.test(out) && Date.now() < deadline && p.exitCode === null) await Bun.sleep(50);
  p.kill();
  await Promise.race([reading, Bun.sleep(1000)]);
  return out;
}

describe("🔴 the outbox worker — on a real boot, and never under test", () => {
  test("🔑 PRODUCTION unchanged, by value: `bun src/index.ts` (the `start` script) starts the worker", async () => {
    const out = await runUntil(["bun", "src/index.ts"], /\[outbox\] LINE worker started/, 20_000);
    expect(out).toContain("[outbox] LINE worker started (every 15s)");
  }, 30_000);
  test("🔴 a TEST process that imports the root app does NOT start it (no `[outbox]` line at all)", async () => {
    const out = await runUntil(["bun", "test", "src/services/public-checkin-shape-req108.test.ts"], /\d+ pass[\s\S]*\d+ fail|Ran \d+ tests/, 60_000);
    expect(out).toMatch(/Ran \d+ tests/); // the file really ran (and imported `../index`)
    expect(out).not.toContain("[outbox]");
  }, 70_000);
  test("by source: the ONE start is guarded by `import.meta.main` — no env var decides it", async () => {
    const I = (await Bun.file(resolve(root, "src/index.ts")).text()).replace(/^\s*\/\/.*$/gm, "");
    expect(I.match(/startOutboxWorker\(\)/g)?.length).toBe(1);
    expect(I).toContain("if (import.meta.main) startOutboxWorker();");
  });
});
