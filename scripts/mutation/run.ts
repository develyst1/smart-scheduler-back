// TASK-576 — the mutation DRIVER: apply each mutation, run the named tests, restore the files byte-for-byte, and report each
// mutation's verdict through `verdict.ts` (the ONE decision). Usage and the verdict rule: ./README.md.
//
//   bun run mutation:run -- --tests "src/a.test.ts src/b.test.ts" --mutations path/to/mutations.json [--baseline N]
//
// Safety, every run: the database is UNREACHABLE and the LINE token BLANK (a mutation must not be able to touch anything real);
// every touched file is restored and its bytes checked; the working tree's checksum is compared before and after the whole run.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_BUFFER, runAndClassify, type VerdictResult } from "./verdict";

export interface Mutation { id: string; what: string; files: Array<{ file: string; edits: Array<{ from: string; to: string }> }> }

const ROOT = resolve(import.meta.dir, "..", "..");
const SAFE_ENV = { ...process.env, DATABASE_URL: "postgres://x:x@127.0.0.1:1/closed", LINE_CHANNEL_ACCESS_TOKEN: "" };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Run the tests once, through the ONE runner in `verdict.ts` (no shell, MAX_BUFFER, the verdict from counts only). */
export function runTests(tests: string, baseline: number, timeoutMs = 300_000): VerdictResult {
  return runAndClassify(tests.split(/\s+/).filter(Boolean), baseline, { cwd: ROOT, timeoutMs, env: SAFE_ENV });
}

/** The working tree's fingerprint (read-only git): every tracked change + every untracked file's bytes. */
function treeChecksum(): string {
  const diff = execSync("git diff", { cwd: ROOT, maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"] });
  const untracked = execSync("git ls-files --others --exclude-standard -z", { cwd: ROOT, maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").split("\0").filter(Boolean);
  return sha(Buffer.concat([diff, ...untracked.map((f) => readFileSync(resolve(ROOT, f)))]));
}

/** Apply one mutation's edits (each anchor must match EXACTLY once; line endings preserved), run, restore. */
export function runMutation(m: Mutation, tests: string, baseline: number): string {
  const saved = m.files.map((f) => ({ path: resolve(ROOT, f.file), orig: readFileSync(resolve(ROOT, f.file)), f }));
  const next: string[] = [];
  for (const x of saved) {
    let s = x.orig.toString("utf8");
    const nl = s.includes("\r\n") ? "\r\n" : "\n";
    for (const e of x.f.edits) {
      const from = e.from.replace(/\n/g, nl);
      const n = s.split(from).length - 1;
      if (n !== 1) return `${m.id} ANCHOR ${n === 0 ? "MISSING" : `AMBIGUOUS (${n})`}: ${x.f.file}: ${e.from.slice(0, 70)}`;
      s = s.replace(from, e.to.replace(/\n/g, nl));
    }
    next.push(s);
  }
  let r: VerdictResult;
  try {
    saved.forEach((x, i) => writeFileSync(x.path, next[i]!));
    r = runTests(tests, baseline);
  } finally {
    saved.forEach((x) => writeFileSync(x.path, x.orig));
  }
  const restored = saved.every((x) => sha(readFileSync(x.path)) === sha(x.orig));
  const shown = r.verdict === "SURVIVED" ? "SURVIVED ⚠" : r.verdict;
  return `${m.id} ${shown}${r.why ? ` [${r.why}]` : ""} (${r.passes ?? "?"} pass / ${r.fails ?? "?"} fail vs baseline ${baseline}, ${r.bytes} bytes) — ${m.what} — restore ${restored ? "byte-identical" : "MISMATCH!!"}`;
}

if (import.meta.main) {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const tests = arg("tests");
  const file = arg("mutations");
  if (!tests || !file) {
    console.error('usage: bun run mutation:run -- --tests "<test files>" --mutations <mutations.json> [--baseline N]');
    process.exit(2);
  }
  const mutations: Mutation[] = JSON.parse(readFileSync(resolve(file), "utf8"));
  const before = treeChecksum();
  // The baseline is MEASURED unless given: an unmutated run that is not itself a clean SURVIVED is no baseline at all.
  const measured = runTests(tests, 0);
  if (measured.verdict !== "SURVIVED") {
    console.error(`baseline run is not clean: ${measured.verdict}${measured.why ? ` [${measured.why}]` : ""} (${measured.passes ?? "?"} pass / ${measured.fails ?? "?"} fail) — no mutation was run`);
    process.exit(1);
  }
  const baseline = Number(arg("baseline") ?? measured.passes);
  console.log(`baseline ${baseline} (${measured.bytes} bytes)`);
  for (const m of mutations) console.log(runMutation(m, tests, baseline));
  const after = treeChecksum();
  console.log(after === before ? "CHECKSUM identical" : "CHECKSUM DIFFERS — the tree is NOT as it was");
  if (after !== before) process.exit(1);
}
