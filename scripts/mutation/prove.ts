// TASK-576 — PROVE the verdict rule on REAL runs, from this home: `bun run mutation:prove`. Exits non-zero if any case is wrong.
// The fixtures are written to a TEMP directory and deleted — they never enter the repo's own suite (one of them fails on purpose).
//
//   1. ~2 MiB of output + one FAILING test   ⇒ BITES      (Node's 1 MiB default lost this summary and read it GREEN)
//   2. ~2 MiB of output, every test PASSING  ⇒ SURVIVED   (the SIGTERM-as-"hung" family read this one as a BITE)
//   3. the same run, capture FORCED to overflow ⇒ NO RESULT [OUTPUT OVERFLOW] — never a colour
//   4. a run KILLED by the time limit         ⇒ NO RESULT [KILLED …]       — a timeout is not a bite
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, runAndClassify, type VerdictResult } from "./verdict";

const dir = mkdtempSync(join(tmpdir(), "mutation-prove-"));
const fixture = (name: string, body: string) => writeFileSync(join(dir, name), `import { expect, test } from "bun:test";\n${body}\n`);
fixture("fails.test.ts", 'test("prints ~2 MiB then fails", () => { console.log("x".repeat(2 * 1024 * 1024)); expect(1).toBe(2); });\ntest("passes", () => { expect(1).toBe(1); });');
fixture("passes.test.ts", 'test("prints ~2 MiB and passes", () => { console.log("x".repeat(2 * 1024 * 1024)); expect(1).toBe(1); });');
fixture("hangs.test.ts", 'test("outlives the run", async () => { await new Promise((r) => setTimeout(r, 60_000)); });');

// THE SAME runner the driver uses (`runAndClassify`) — the proof exercises the real path, not a copy of it.
const run = (file: string, opts: { maxBuffer?: number; timeout?: number; baseline: number }): VerdictResult =>
  runAndClassify([file], opts.baseline, { cwd: dir, timeoutMs: opts.timeout ?? 120_000, maxBuffer: opts.maxBuffer, testTimeoutMs: 120_000 });

const cases: Array<[string, () => VerdictResult, (r: VerdictResult) => boolean]> = [
  ["1 · >1 MiB, one failing test ⇒ BITES", () => run("fails.test.ts", { baseline: 1 }), (r) => r.verdict === "BITES" && r.fails === 1 && r.bytes > 2 * 1024 * 1024],
  ["2 · >1 MiB, every test passing ⇒ SURVIVED", () => run("passes.test.ts", { baseline: 1 }), (r) => r.verdict === "SURVIVED" && r.fails === 0],
  ["3 · the capture forced to overflow ⇒ NO RESULT", () => run("passes.test.ts", { baseline: 1, maxBuffer: 64 * 1024 }), (r) => r.verdict === "NO RESULT" && r.why === "OUTPUT OVERFLOW"],
  ["4 · killed by the time limit ⇒ NO RESULT", () => run("hangs.test.ts", { baseline: 1, timeout: 5_000 }), (r) => r.verdict === "NO RESULT" && (r.why ?? "").startsWith("KILLED")],
  ["5 · no output at all ⇒ NO RESULT", () => classify("", null, 1), (r) => r.verdict === "NO RESULT" && r.why === "NO SUMMARY"],
];

let wrong = 0;
try {
  for (const [name, go, ok] of cases) {
    const r = go();
    const good = ok(r);
    if (!good) wrong++;
    console.log(`${good ? "✅" : "❌"} ${name} — got ${r.verdict}${r.why ? ` [${r.why}]` : ""} (${r.passes ?? "?"} pass / ${r.fails ?? "?"} fail, ${r.bytes} bytes)`);
  }
} finally {
  // Windows: the process case 4 KILLED can hold the directory for a moment — retry, and never let cleanup decide the verdict.
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); }
  catch (e: any) { console.warn(`(cleanup: ${dir} still locked — ${e?.code ?? e}; it holds only the three throwaway fixtures)`); }
}
console.log(wrong ? `\n❌ ${wrong} case(s) wrong — the verdict rule does NOT hold here` : "\n✅ the verdict rule holds on real runs");
process.exit(wrong ? 1 : 0);
