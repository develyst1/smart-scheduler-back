// TASK-267 — 🔴 this file EXECUTES `db:migrate:through --plan`. It does not read its source.
//
// ## Why that distinction is the whole task
// TASK-266's split command was written, reviewed and merged — and had **never been run once**. @Porter:
// *"a deploy tool whose entire job is to be executed had never been executed once."* It failed on `sid` with
// `Cannot find module 'drizzle-kit'`, because the generated config lived in the OS temp folder and module
// resolution never reached this repo's `node_modules`.
//
// ⚠️ **And the failure was in the half that needs no database.** Config placement is decided before a connection
// is opened. It was always testable; nobody made it testable. Every source assertion I could have written would
// have passed on the broken build — the config was correct, the copies were correct, the ledger table was
// correct. Only *running it* said no.
//
// 🚫 So nothing here asserts against text. It spawns the real script, with no `DATABASE_URL`, and reads what it
// printed and what it left behind.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolvesByNodeWalk } from "./migrate-preflight";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");

/**
 * Run the real script. `DATABASE_URL` is explicitly EMPTY — an explicitly-set variable wins over `.env`, so
 * this proves `--plan` needs no database rather than quietly using whichever one the developer has configured.
 */
const runPlan = (...args: string[]) =>
  Bun.spawnSync(["bun", "run", "scripts/migrate-through.ts", ...args], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: "" },
  });

const scratchDirs = () => readdirSync(root).filter((f) => f.startsWith(".migrate-through-"));

describe("TASK-267 — `--plan` runs, and this test is the run", () => {
  const r = runPlan("0032_booking_paused_status", "--plan");
  const out = r.stdout.toString() + r.stderr.toString();

  test("🔴 it exits 0 with no DATABASE_URL at all", () => {
    // The real command still demands one; `--plan` must not, or the mode that exists to be testable is not.
    expect({ code: r.exitCode, out }).toMatchObject({ code: 0 });
  });

  test("🔑 `drizzle-kit` resolves FROM THE CONFIG'S OWN DIRECTORY — the exact failure on sid", () => {
    // Not "drizzle-kit is installed" — it always was. The question is whether it resolves from where the
    // generated config sits, which is the only place that matters and the thing the OS temp folder broke.
    expect(out).toContain("(found by walking up from the config, as node does)");
    expect(out).toContain("node_modules/drizzle-kit");
    expect(out).toContain("config         : loads and exports a config ✓");
    expect(out).not.toContain("Cannot find module");
  });

  test("the scratch folder is INSIDE the repo", () => {
    // The fix, stated as an observation of the running program rather than of its source.
    const line = out.split("\n").find((l) => l.includes("scratch folder"))!;
    expect(line).toContain(root);
  });

  test("it lists the right migrations, in journal order, ending at the tag", () => {
    const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const expected = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === "0032_booking_paused_status") + 1);
    const listed = out
      .split("\n")
      .map((l) => l.match(/^ {2}\d{4} {2}(\S+)$/)?.[1])
      .filter((x): x is string => !!x);
    expect(listed).toEqual(expected.map((e) => e.tag));
    // ⚠️ …and it says what that list IS. "33 migrations" without this line reads, on a live box, as "about to
    // re-run the world" — `--plan` cannot see the ledger, so it must not imply it can.
    expect(out).toContain("drizzle applies only the ones missing from the ledger");
  });

  test("🚫 it says plainly that nothing happened, and prints the command it would have run", () => {
    expect(out).toContain("✅ --plan: nothing was applied and no database was contacted.");
    expect(out).toContain("bunx drizzle-kit migrate --config");
    expect(out).toContain("scripts/verify-migrations.ts --through 0032_booking_paused_status");
  });

  test("🔴 no connection is attempted — the script cannot open one", () => {
    // Asserted structurally rather than by watching a socket: this script imports no database driver, so
    // "it did not connect" is a property of what it can do, not of the path it happened to take.
    const src = readFileSync(resolve(root, "scripts/migrate-through.ts"), "utf8");
    for (const driver of ['from "postgres"', 'from "pg"', "drizzle-orm/postgres-js"]) {
      expect({ driver, imported: src.includes(driver) }).toEqual({ driver, imported: false });
    }
  });
});

describe("TASK-267 — the scratch folder never outlives the run", () => {
  test("🔴 removed on SUCCESS", () => {
    expect(scratchDirs()).toEqual([]);
    runPlan("0032_booking_paused_status", "--plan");
    expect(scratchDirs()).toEqual([]);
  });

  test("🔴 removed on FAILURE — an unknown tag", () => {
    const r = runPlan("0099_does_not_exist", "--plan");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("no migration tagged 0099_does_not_exist");
    expect(scratchDirs()).toEqual([]);
  });

  test("a missing tag argument is refused before anything is built", () => {
    const r = runPlan("--plan");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("a migration tag is required");
    expect(scratchDirs()).toEqual([]);
  });

  test("🚫 the real run still demands a DATABASE_URL — `--plan` did not weaken it", () => {
    const r = runPlan("0032_booking_paused_status");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("DATABASE_URL required");
    expect(scratchDirs()).toEqual([]);
  });

  test("the scratch name is gitignored — the net under the cleanup", () => {
    // `process.exit()` does not run `finally`, so the cleanup is only correct because nothing calls it inside
    // the try. This line is what stops a bug in that arrangement becoming a committed directory.
    expect(readFileSync(resolve(root, ".gitignore"), "utf8")).toContain(".migrate-through-*");
  });
});

describe("TASK-267 — the resolution check reproduces the failure, and I verified that it does", () => {
  const RE = "drizzle-kit";
  test("🔴 it FAILS from a directory with no node_modules above it", () => {
    // The `sid` arrangement. ⚠️ `Bun.resolveSync` does NOT fail here — it succeeds out of Bun's global
    // install cache — which is why this walk exists instead. A probe that passes on the broken arrangement
    // is a comfort, not a control, and I only found that out by mutating the script and watching the
    // resolution line still print ✓.
    expect(resolvesByNodeWalk("/tmp/scratch-x", RE, () => false)).toBeNull();
  });

  test("it finds the package by walking UP, not only in the starting directory", () => {
    const present = new Set(["/repo/node_modules/drizzle-kit"]);
    expect(resolvesByNodeWalk("/repo/.scratch-abc", RE, (p) => present.has(p))).toBe("/repo/node_modules/drizzle-kit");
    expect(resolvesByNodeWalk("/repo/a/b/c", RE, (p) => present.has(p))).toBe("/repo/node_modules/drizzle-kit");
  });

  test("⚠️ Windows separators — the first version was forward-slash only and said 'not reachable' from INSIDE the repo", () => {
    const present = new Set(["H:\\repo/node_modules/drizzle-kit"]);
    expect(resolvesByNodeWalk("H:\\repo\\.scratch-abc", RE, (p) => present.has(p))).toBe(
      "H:\\repo/node_modules/drizzle-kit",
    );
  });

  test("it terminates at a bare drive letter and at the filesystem root", () => {
    expect(resolvesByNodeWalk("H:" + String.fromCharCode(92) + "a", RE, () => false)).toBeNull();
    expect(resolvesByNodeWalk("/a", RE, () => false)).toBeNull();
  });
});
