// TASK-575 / TASK-576 — THE mutation verdict, and nothing else. Every runner decides through this one function.
// The RULE (README.md, "The verdict rule") is what matters; this is its implementation in this repo.
//
//   · a verdict comes ONLY from the parsed FINAL summary lines of `bun test` (`N pass`, `N fail`);
//   · BITES     — the summary says a test failed, or fewer passed than the unmutated baseline;
//   · SURVIVED  — the summary says nothing failed and at least the baseline passed;
//   · NO RESULT — there is no summary to read (the output overflowed, the run was killed, it timed out, it crashed).
//     🚫 NEVER a colour: not "passed", not "bites". A timeout is not a bite; an absent summary is not a pass.
//
// Why, in two incidents: a runner with Node's default 1 MiB `maxBuffer` lost the summary on a big run and read it as GREEN
// (the FE's, TASK-575); another family read the overflow's SIGTERM as "hung" and so as a BITE — proven to call an all-passing
// run caught. Both were false reassurance. Counts are the truth.

import { spawnSync } from "node:child_process";

export type Verdict = "BITES" | "SURVIVED" | "NO RESULT";
export interface VerdictResult {
  verdict: Verdict;
  /** Why there is NO RESULT — present only then. */
  why?: string;
  passes: number | null;
  fails: number | null;
  /** The output's size in bytes: a run near the buffer is worth knowing about before it becomes a NO RESULT. */
  bytes: number;
}

/** 512 MiB — the buffer every run is captured with (Node's default is 1 MiB, the limit that lost a summary). */
export const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Run `bun test <files>` ONCE and classify it. 🔑 `bun` is spawned DIRECTLY — no shell: through a shell the time limit
 * kills the SHELL and leaves `bun` running as an orphan (found by the proof on Windows). Captured with MAX_BUFFER.
 */
export function runAndClassify(files: string[], baseline: number, opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; maxBuffer?: number; testTimeoutMs?: number }): VerdictResult {
  const r = spawnSync("bun", ["test", "--timeout", String(opts.testTimeoutMs ?? 90_000), ...files], {
    cwd: opts.cwd, encoding: "utf8", timeout: opts.timeoutMs, env: opts.env ?? process.env, maxBuffer: opts.maxBuffer ?? MAX_BUFFER,
  });
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  const error = r.error ? { code: (r.error as any).code, signal: r.signal, message: r.error.message } : r.signal ? { signal: r.signal } : null;
  return classify(output, error, baseline);
}

/** The LAST match: the final summary, never a number quoted inside a failure's printed source. */
const lastNumber = (output: string, re: RegExp): number | null => {
  const all = [...output.matchAll(re)];
  return all.length ? Number(all[all.length - 1]![1]) : null;
};

/**
 * @param output   everything the test run printed (stdout + stderr)
 * @param error    what running it threw, if anything (a non-zero exit is normal for a biting mutation)
 * @param baseline how many tests pass with NO mutation applied, measured on the same test set
 */
export function classify(output: string, error: { code?: string; signal?: string | null; message?: string } | null, baseline: number): VerdictResult {
  const fails = lastNumber(output, /^\s*(\d+) fail\s*$/gm);
  const passes = lastNumber(output, /^\s*(\d+) pass\s*$/gm);
  const bytes = Buffer.byteLength(output);
  if (fails === null || passes === null) {
    const why =
      error?.code === "ENOBUFS" ? "OUTPUT OVERFLOW"
      : error?.signal ? `KILLED (${error.signal})`
      : error ? `ERROR (${error.code ?? (error.message ?? "").slice(0, 60)})`
      : "NO SUMMARY";
    return { verdict: "NO RESULT", why, passes, fails, bytes };
  }
  return { verdict: fails > 0 || passes < baseline ? "BITES" : "SURVIVED", passes, fails, bytes };
}
