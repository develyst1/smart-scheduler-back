// TASK-268 — `bunx` leaves the deploy path, so `--plan` checks the binary the run actually uses.
//
// 🔴 The gap was mine, flagged at the end of TASK-267: `--plan` proved the MODULE resolves from the config's
// directory, and the run then executed `bunx drizzle-kit` — **a different resolution that nothing checked.**
// They agreed, and *two things that agree today* is this project's most repeated lesson.
//
// ⚠️ The obvious fix — resolve `node_modules/.bin/drizzle-kit` — does not work here: on this machine that file
// **does not exist**. `.bin` holds `drizzle-kit.exe` and `drizzle-kit.bunx` (Windows shims) while POSIX gets a
// bare symlink, so resolving it means guessing a per-platform name. ⇒ read the package's own `bin` field, which
// is what every shim ultimately runs and is the same on every platform.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveDrizzleKitBin } from "./migrate-preflight";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (p: string) => readSrc(readFileSync(resolve(root, p), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

/** A fake tree: `/repo/node_modules/drizzle-kit/{package.json,bin.cjs}`. */
const tree = (opts: { bin?: unknown; binFileExists?: boolean; pkgExists?: boolean } = {}) => {
  // ⚠️ `"bin" in opts`, not a default parameter: passing `bin: undefined` to a default would silently get
  // the default back, and the "no bin field" case would test nothing. It did exactly that on the first run.
  const bin = "bin" in opts ? opts.bin : { "drizzle-kit": "./bin.cjs" };
  const { binFileExists = true, pkgExists = true } = opts;
  const exists = (p: string) => {
    if (p === "/repo/node_modules/drizzle-kit") return pkgExists;
    if (p === "/repo/node_modules/drizzle-kit/bin.cjs") return binFileExists;
    return false;
  };
  const readJson = (p: string) => {
    if (p === "/repo/node_modules/drizzle-kit/package.json") return { bin };
    throw new Error("ENOENT");
  };
  return { exists, readJson };
};

describe("TASK-268 — the binary comes from the package's own `bin` field", () => {
  test("🔑 it resolves the real thing, in this repo, right now", () => {
    // Not a fixture: the actual installed package, because the claim is about what the deploy will execute.
    const p = resolveDrizzleKitBin(root, existsSync, (f) => JSON.parse(readFileSync(f, "utf8")));
    expect(p).toBeTruthy();
    expect(p!.endsWith("bin.cjs")).toBe(true);
    expect(JSON.parse(readFileSync(resolve(root, "node_modules/drizzle-kit/package.json"), "utf8")).bin).toEqual({
      "drizzle-kit": "./bin.cjs",
    });
  });

  test("a `bin` given as a bare STRING works too — the other shape npm allows", () => {
    const { exists, readJson } = tree({ bin: "./bin.cjs" });
    expect(resolveDrizzleKitBin("/repo/scratch", exists, readJson)).toBe("/repo/node_modules/drizzle-kit/bin.cjs");
  });

  test("it walks UP, like the module check — the config lives in a scratch folder", () => {
    const { exists, readJson } = tree();
    expect(resolveDrizzleKitBin("/repo/a/b/c", exists, readJson)).toBe("/repo/node_modules/drizzle-kit/bin.cjs");
  });
});

describe("TASK-268 — it FAILS CLOSED, and each way it can fail is its own case", () => {
  test("🚫 no package ⇒ null", () => {
    const { exists, readJson } = tree({ pkgExists: false });
    expect(resolveDrizzleKitBin("/repo/scratch", exists, readJson)).toBeNull();
  });

  test("🚫 no `bin` field ⇒ null — not a guess at a conventional path", () => {
    // The whole point of reading the field is that we do not invent the filename. If the field is gone, we do
    // not know what to run, and pretending we do is how a deploy step executes the wrong thing.
    const { exists, readJson } = tree({ bin: undefined });
    expect(resolveDrizzleKitBin("/repo/scratch", exists, readJson)).toBeNull();
  });

  test("🚫 a `bin` naming a file that is not there ⇒ null", () => {
    const { exists, readJson } = tree({ binFileExists: false });
    expect(resolveDrizzleKitBin("/repo/scratch", exists, readJson)).toBeNull();
  });

  test("🚫 an unreadable package.json ⇒ null, never a throw", () => {
    // A preflight that crashes is a preflight whose message nobody reads.
    const exists = (p: string) => p === "/repo/node_modules/drizzle-kit";
    const readJson = () => {
      throw new Error("EACCES");
    };
    expect(resolveDrizzleKitBin("/repo/scratch", exists, readJson)).toBeNull();
  });

  test("🔴 …and the SCRIPT refuses when it is null — break it and watch", () => {
    // The resolver returning null is only half the control; the script has to stop. Asserted at the branch,
    // because there is no way to make the real package disappear from inside a test.
    const c = code(src("scripts/migrate-through.ts"));
    expect(c).toContain("if (!binPath) {");
    expect(c).toContain('throw new Error("resolution");');
    expect(src("scripts/migrate-through.ts")).toContain(
      "This run would have had nothing to execute. Nothing was applied and no database was contacted.",
    );
  });
});

describe("TASK-268 — `bunx` is gone from the deploy path", () => {
  test("🚫 the migrate is spawned with the RESOLVED path", () => {
    const c = code(src("scripts/migrate-through.ts"));
    expect(c).toContain('Bun.spawnSync(["bun", binPath, "migrate", "--config", cfg]');
    expect(c).not.toContain('"bunx"');
  });

  test("🚫 no executable path in the repo uses `bunx`", () => {
    // The sweep the task asked for, kept as a test so it stays true.
    for (const f of ["scripts/migrate-through.ts", "scripts/migrate-preflight.ts", "scripts/verify-migrations.ts"]) {
      expect({ f, bunx: code(src(f)).includes("bunx") }).toEqual({ f, bunx: false });
    }
    const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> };
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect({ name, bunx: cmd.includes("bunx") }).toEqual({ name, bunx: false });
    }
  });

  test("🔑 PENDING DEPLOY 8's two commands are UNCHANGED", () => {
    // §4: if this changes them, stop. It does not — `bunx` was internal to the script, and the only place it
    // ever surfaced was `--plan`'s "would run" line.
    const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["db:migrate:through"]).toBe("bun run scripts/migrate-through.ts");
    expect(pkg.scripts["db:migrate"]).toBe("bun run db:preflight && drizzle-kit migrate && bun run db:verify");
  });
});
