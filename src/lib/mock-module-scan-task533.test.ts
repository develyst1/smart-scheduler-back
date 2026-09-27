// TASK-533 (@Fern's finding in TASK-532) — every `mock.module` in this repo must SPREAD the real module.
//
// 🔴 `mock.module` is global to the test PROCESS. A mock that returns only the members its own file needs silently DELETES the
// rest for every other file in that process — and the failure (`SyntaxError: Export named 'x' not found`) names the innocent
// importer, not the mock. This repo paid for it five times before TASK-072 removed every whole-module stub in favour of narrow
// `spyOn`s (see `src/services/module-isolation.test.ts`).
//
// 📌 Today there are ZERO `mock.module` calls in the repo — only comments recording that TASK-072 removed them (the five files a
// plain grep finds). So nothing is edited; this file is the pin that stops the NEXT one being written the narrow way.
// ⚠️ An exception (a module whose import must not run, say) is allowed ONLY by name, with its reason, in `EXCEPTIONS` below —
// and a stale exception (naming a call that no longer exists) fails too. A scan that cannot express a legitimate exception
// gets deleted (TASK-512's lesson).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
// Spelled in two halves so this file's own samples and messages are never mistaken for a call by the scan below.
const CALL = "mock" + ".module(";

/** `file → the module specifier it mocks → why it may NOT expose the real module`. Empty today; each entry needs a real reason. */
const EXCEPTIONS: Record<string, Record<string, string>> = {};

/** Comments removed (block, then line), so a note ABOUT the call is never read as the call. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

/** The text of one call, from its `(` to the matching `)` — strings are skipped so a `)` inside one does not end it. */
function callText(s: string, open: number): string {
  let depth = 0, i = open, q: string | null = null;
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) break;
  }
  return s.slice(open, i + 1);
}

export type MockFinding = { file: string; specifier: string; spreads: boolean; excepted: string | null };

/** Every call in one source text, with whether its factory spreads something (the real module) into the replacement. */
export function scanSource(file: string, text: string, exceptions = EXCEPTIONS): MockFinding[] {
  const s = stripComments(readSrc(text));
  const out: MockFinding[] = [];
  for (let at = s.indexOf(CALL); at >= 0; at = s.indexOf(CALL, at + CALL.length)) {
    const call = callText(s, at + CALL.length - 1);
    const specifier = /^\(\s*(["'`])([^"'`]+)\1/.exec(call)?.[2] ?? "?";
    // A spread of an identifier holding the real module, or of `await import(...)` directly.
    const spreads = /\.\.\.\s*(\(\s*)?(await\s+import\s*\(|[A-Za-z_$][\w$]*)/.test(call);
    const reason = exceptions[file]?.[specifier] ?? null;
    out.push({ file, specifier, spreads, excepted: reason });
  }
  return out;
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mts)$/.test(n) ? [p] : [];
  });

const FILES = [...walk(resolve(root, "src")), ...walk(resolve(root, "scripts"))];
const ALL = FILES.flatMap((p) => scanSource(relative(root, p).replace(/\\/g, "/"), readFileSync(p, "utf8")));

describe("🔴 TASK-533 — every `mock.module` spreads the real module (or is a NAMED exception with its reason)", () => {
  test("the scan reads the whole repo (src + scripts), not a sample", () => {
    expect(FILES.length).toBeGreaterThan(400);
    expect(FILES.some((f) => f.endsWith("module-isolation.test.ts"))).toBe(true);
  });

  test("🔑 no call in the repo is narrow: each one spreads, or is listed in EXCEPTIONS with a reason", () => {
    const narrow = ALL.filter((f) => !f.spreads && !f.excepted).map((f) => `${f.file} → ${f.specifier}`);
    // If this fails: spread the real module — `mock.module(spec, async () => ({ ...(await import(spec)), oneMember: fake }))` —
    // or better, as TASK-072 did, use `spyOn(module, "member")` and restore it: a spread mock still swaps that one member for
    // every file in the process. A genuine exception goes in EXCEPTIONS with its reason.
    expect(narrow).toEqual([]);
  });

  test("📌 today: ZERO calls — TASK-072 removed them all; the five files a grep finds are comments about that", () => {
    expect(ALL).toEqual([]);
  });

  test("every exception names a call that EXISTS and carries a real reason (no stale or silent exceptions)", () => {
    for (const [file, specs] of Object.entries(EXCEPTIONS)) {
      for (const [specifier, reason] of Object.entries(specs)) {
        expect({ file, specifier, exists: ALL.some((f) => f.file === file && f.specifier === specifier) }).toEqual({ file, specifier, exists: true });
        expect({ file, specifier, reasoned: reason.trim().length >= 20 }).toEqual({ file, specifier, reasoned: true });
      }
    }
  });
});

describe("the scanner itself — proven on samples, so a green scan over zero calls is not a vacuous one", () => {
  const one = (src: string, ex = {}) => scanSource("x.test.ts", src, ex);
  test("a NARROW mock is caught, with its specifier", () => {
    expect(one(`${CALL}"../services/a", () => ({ onlyThis: () => 1 }));`)).toEqual([{ file: "x.test.ts", specifier: "../services/a", spreads: false, excepted: null }]);
  });
  test("a spread of the real module passes — by identifier, or by `await import` directly", () => {
    expect(one(`const real = await import("./a");\n${CALL}"./a", () => ({ ...real, f: () => 1 }));`)[0]!.spreads).toBe(true);
    expect(one(`${CALL}"./a", async () => ({ ...(await import("./a")), f: () => 1 }));`)[0]!.spreads).toBe(true);
  });
  test("a note ABOUT the call — line or block comment — is not a call", () => {
    expect(one(`// the old ${CALL}"./a", () => ({}))\n/* ${CALL}"./b", () => ({})) */\nconst x = 1;`)).toEqual([]);
  });
  test("a `)` inside a string does not end the call early (the spread after it is still seen)", () => {
    expect(one(`${CALL}"./a", () => ({ label: "a)b", ...real }));`)[0]!.spreads).toBe(true);
  });
  test("an EXCEPTION is honoured by file + specifier — and only that pair", () => {
    const ex = { "x.test.ts": { "./a": "importing ./a opens a socket at load time" } };
    const [f] = one(`${CALL}"./a", () => ({ f: () => 1 }));`, ex);
    expect(f!.excepted).toBe("importing ./a opens a socket at load time");
    expect(one(`${CALL}"./b", () => ({ f: () => 1 }));`, ex)[0]!.excepted).toBeNull();
  });
});
