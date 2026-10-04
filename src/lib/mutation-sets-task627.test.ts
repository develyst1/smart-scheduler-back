// TASK-627 — a mutation SET is a FILE in the repo beside the test it proves, and this test keeps those files HONEST.
//
// 🔑 @Sober's finding was that we put the TOOL in the repo and left the EVIDENCE in the scratchpad. Filing the evidence only
//    half-fixes it: a filed set whose `from` anchor no longer matches is a SILENT lie — the same class as the four silenced pins,
//    where a lost anchor made a check stop speaking (and one of them start LYING, because the slice ran to EOF instead).
// ⇒ So every filed set is checked here: each anchor must resolve EXACTLY ONCE, and every test file it names must exist.
//    🚫 This does not re-run the mutations — it proves the recorded verdicts are still RE-RUNNABLE, which is the whole point.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const sets = readdirSync(resolve(root, "src", "lib"))
  .filter((f) => f.endsWith(".mutations.json"))
  .map((f) => `src/lib/${f}`);

describe("🔴 TASK-627 — every filed mutation set is still re-runnable", () => {
  test("there is at least one filed set (the convention is live, not just written down)", () => {
    expect(sets.length).toBeGreaterThan(0);
  });

  for (const set of sets) {
    const s = JSON.parse(readFileSync(resolve(root, set), "utf8"));
    describe(set, () => {
      test("it names the test it proves, and that file exists", () => {
        expect(typeof s.proves).toBe("string");
        expect({ proves: s.proves, exists: existsSync(resolve(root, s.proves)) }).toEqual({ proves: s.proves, exists: true });
      });
      test("🔑 it carries its own TEST LIST — a verdict measured against a list in somebody's shell is a number on trust", () => {
        expect(typeof s.tests).toBe("string");
        for (const t of s.tests.split(" ").filter(Boolean)) {
          expect({ test: t, exists: existsSync(resolve(root, t)) }).toEqual({ test: t, exists: true });
        }
        expect(s.tests.split(" ")).toContain(s.proves); // the set always runs the test it proves
      });
      test("🔴 every `from` anchor resolves EXACTLY ONCE — not zero (silent), not twice (ambiguous)", () => {
        expect(Array.isArray(s.mutations)).toBe(true);
        expect(s.mutations.length).toBeGreaterThan(0);
        for (const m of s.mutations) {
          for (const f of m.files) {
            const raw = readFileSync(resolve(root, f.file), "utf8");
            // 🔑 the anchors are written with `\n`; the runner converts to each file's own endings, so this check must too
            const crlf = raw.includes("\r\n");
            for (const e of f.edits) {
              const from = crlf ? e.from.replace(/\n/g, "\r\n") : e.from;
              expect({ id: m.id, file: f.file, matches: raw.split(from).length - 1 }).toEqual({ id: m.id, file: f.file, matches: 1 });
              expect(e.to).not.toBe(e.from); // a mutation that changes nothing survives everything
            }
          }
        }
      });
      test("every mutation says WHAT it breaks, in words — the id alone tells a reader nothing", () => {
        const ids = s.mutations.map((m: any) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const m of s.mutations) expect(m.what.length).toBeGreaterThan(12);
      });
    });
  }
});

describe("🔑 TASK-627 — the runner accepts a self-contained set, and the README no longer sends sets to the report", () => {
  const RUN = readFileSync(resolve(root, "scripts/mutation/run.ts"), "utf8").replace(/\r\n/g, "\n");
  const README = readFileSync(resolve(root, "scripts/mutation/README.md"), "utf8").replace(/\r\n/g, "\n");
  test("the loader reads `{ tests, mutations }` as well as the old bare ARRAY (old sets keep working)", () => {
    expect(RUN).toContain("Array.isArray(parsed) ? parsed : parsed.mutations");
    expect(RUN).toContain('const tests = arg("tests") ?? (Array.isArray(parsed) ? undefined : parsed.tests);');
  });
  test("…and a set with NO test list anywhere is refused rather than guessed at", () => {
    expect(RUN).toContain("if (!tests) {");
    expect(RUN).toContain("no test list: pass --tests, or give the set a");
  });
  test("🔴 the README records that the set belongs in the REPO, superseding the old bullet", () => {
    expect(README).toContain("TASK-627 SUPERSEDES");
    expect(README).toContain("A mutation SET is a FILE in the repo, beside the test it proves");
    // 🔑 the old sentence survives only as a QUOTE of what it used to say, inside the correction. ⚠️ My first version of
    // this check asserted the quote and "It used to read" share a LINE — they do not, the quote wraps — so it FAILED ON A CORRECT
    // README. The claim is about the BLOCK: the sentence may not stand on its own as advice any more.
    const i = README.indexOf("which is where they belong");
    expect(i).toBeGreaterThan(0);
    expect(README.slice(Math.max(0, i - 400), i)).toContain("It used to read");
  });
});
