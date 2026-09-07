// TASK-266 §4 / TASK-267 — the SPLIT command. Apply the pending set **up to and including one tag**, then
// verify it.
//
//   bun run db:migrate:through 0032_booking_paused_status --plan    # dry run: builds everything, connects to nothing
//   bun run db:migrate:through 0032_booking_paused_status           # the real one
//   bun run db:migrate                                              # the rest, preflighted again
//
// 🔴 A refusal that leaves the operator stuck is a worse control than none. `db:preflight` prints exactly these
// commands, so the person reading the refusal has the next step rather than a diagnosis.
//
// ## 🔴 TASK-267 — why the scratch folder is INSIDE the repo
// It was `mkdtempSync(join(tmpdir(), …))`, and the generated config's first line is
// `import { defineConfig } from "drizzle-kit"`. Module resolution walks up from `C:\Users\…\Temp\` and never
// reaches this repo's `node_modules` ⇒ **`Cannot find module 'drizzle-kit'`**, which is exactly what the owner
// hit on `sid`. Inside the repo it resolves the way `drizzle.config.ts` itself does.
// ⚠️ The folder is removed on EVERY exit path, including failure — `process.exit()` does not run `finally`, so
// nothing below calls it inside the try block. A stray directory that looks like a migrations folder is its own
// hazard.
//
// ## How it applies a subset without touching the real folder
// It writes a temporary migrations folder containing the journal entries up to `<tag>` and their `.sql` files
// **byte-for-byte**, plus a temporary drizzle config pointing at it, and then runs the ordinary
// `drizzle-kit migrate`. 🔑 Same tool, same transaction semantics, same ledger table — and because drizzle's
// ledger hash is the sha256 of the file TEXT, the rows it writes are identical to the ones the full command
// would have written. The second run then sees those migrations as applied and continues from there.
// 🚫 The real `drizzle/` folder is never modified, and there is **no fallback to it on any error path**: a tool
// that quietly applies everything when its partial mode fails is worse than one that fails.
//
// ⚠️ This is the one command that makes the batch NOT atomic. Run 1 COMMITS. If run 2 fails, `0032` stays
// applied and the database is in a state no single migration describes. That is the price of applying a set
// Postgres will not take in one transaction, and it must be stated rather than discovered — it is in the
// deploy note.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { entriesThrough, resolveDrizzleKitBin, resolvesByNodeWalk } from "../src/lib/migrate-preflight";

const args = process.argv.slice(2);
const plan = args.includes("--plan");
const tag = args.find((a) => !a.startsWith("--"))?.trim();

if (!tag) {
  console.error("✗ db:migrate:through — a migration tag is required, e.g. 0032_booking_paused_status");
  process.exit(1);
}
// 🔑 TASK-267 §2 — `--plan` needs no database, and that is the whole point: the failure it exists to catch
// happens before any connection is opened, so requiring a URL would have kept it untestable.
if (!plan && !process.env.DATABASE_URL) {
  console.error("✗ db:migrate:through — DATABASE_URL required (or pass --plan for a dry run).");
  process.exit(1);
}

const root = resolve(import.meta.dir, "..");
const dir = resolve(root, "drizzle");
const journal = JSON.parse(readFileSync(resolve(dir, "meta/_journal.json"), "utf8")) as {
  version?: string;
  dialect?: string;
  entries: Array<{ idx: number; tag: string; when: number }>;
};

let entries: Array<{ idx: number; tag: string; when: number }>;
try {
  entries = entriesThrough(journal.entries, tag);
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}

// Inside the repo — see the header. `.migrate-through-*` is gitignored.
const scratch = mkdtempSync(join(root, ".migrate-through-"));
let exitCode = 0;
try {
  mkdirSync(join(scratch, "meta"), { recursive: true });
  writeFileSync(join(scratch, "meta/_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  // Copied, never rewritten: the ledger hash is the sha256 of this text, so a single changed byte would make
  // the second run treat the migration as one it has never seen.
  for (const e of entries) copyFileSync(resolve(dir, `${e.tag}.sql`), join(scratch, `${e.tag}.sql`));

  const cfg = join(scratch, "drizzle.config.ts");
  writeFileSync(
    cfg,
    [
      'import { defineConfig } from "drizzle-kit";',
      "export default defineConfig({",
      `  schema: ${JSON.stringify(resolve(root, "src/db/schema.ts"))},`,
      `  out: ${JSON.stringify(scratch)},`,
      // The SAME ledger table as drizzle.config.ts — a partial run that recorded elsewhere would leave the
      // second run re-applying what it just did.
      '  migrations: { table: "__drizzle_migrations_scheduling", schema: "drizzle" },',
      '  dialect: "postgresql",',
      "  dbCredentials: { url: process.env.DATABASE_URL! },",
      '  casing: "snake_case",',
      "});",
      "",
    ].join("\n"),
  );

  // 🔑 TASK-267 — THE check the owner's failure was: can `drizzle-kit` be reached FROM WHERE THE CONFIG LIVES?
  //
  // ⚠️ NOT `Bun.resolveSync`, and I checked rather than assumed: from the OS temp folder it SUCCEEDS, out of
  // Bun's global install cache (`~/.bun/install/cache/drizzle-kit@…`). It would have printed a ✓ over the
  // exact failure — a probe that passes on the broken arrangement is a comfort, not a control.
  // `resolvesByNodeWalk` is node's own algorithm — walk up for `node_modules/<pkg>` — which is what
  // drizzle-kit's config loader ends up doing. This runs in BOTH modes: the real command must not discover it.
  const resolved = resolvesByNodeWalk(scratch, "drizzle-kit", existsSync);
  if (!resolved) {
    console.error(
      `✗ db:migrate:through — drizzle-kit is not reachable from ${scratch} by walking up for node_modules.` +
        "\n  The generated config imports it, so this run would fail with: Cannot find module drizzle-kit." +
        "\n  Nothing was applied and no database was contacted.",
    );
    exitCode = 1;
    throw new Error("resolution");
  }
  // 🔴 TASK-268 — and the BINARY the run will execute, resolved from the package's own `bin` field rather
  // than from a `.bin` shim whose name differs per platform. `--plan` now checks the thing the real run
  // uses, instead of a different resolution that happens to agree.
  const binPath = resolveDrizzleKitBin(root, existsSync, (f) => JSON.parse(readFileSync(f, "utf8")));
  if (!binPath) {
    console.error(
      "✗ db:migrate:through — drizzle-kit's own bin entry could not be resolved from the repo." +
        "\n  This run would have had nothing to execute. Nothing was applied and no database was contacted.",
    );
    exitCode = 1;
    throw new Error("resolution");
  }

  // …and the config itself must LOAD. Resolution proves the module is findable; importing proves the file we
  // just generated parses and produces a config. Neither opens a connection.
  const loaded = (await import(pathToFileURL(cfg).href)) as { default?: unknown };
  if (!loaded.default) throw new Error("the generated drizzle config exported nothing");

  // ⚠️ These are the migrations HANDED to drizzle, not the ones it will apply. Drizzle skips whatever the
  // ledger already holds, so on a live box most of this list is a no-op — and an operator reading
  // "33 migrations" without that sentence could reasonably think it is about to re-run the world.
  // 🔴 `--plan` cannot tell you which are pending: that answer is in the database it deliberately does not
  // open. `bun run db:preflight` is the command that knows.
  console.log(
    `db:migrate:through ${tag}${plan ? " --plan" : ""} — handing drizzle the ${entries.length} journal ` +
      `entr${entries.length === 1 ? "y" : "ies"} up to and including ${tag}.`,
  );
  console.log("  (drizzle applies only the ones missing from the ledger; the rest are no-ops.)");
  for (const e of entries) console.log(`  ${String(e.idx).padStart(4, "0")}  ${e.tag}`);
  console.log(`\n  scratch folder : ${scratch}`);
  console.log(`  drizzle-kit    : ${resolved} ✓  (found by walking up from the config, as node does)`);
  console.log(`  config         : loads and exports a config ✓`);
  console.log(`  drizzle-kit bin: ${binPath} ✓  (the package's own \`bin\` entry — not a shim, not a PATH lookup)`);
  console.log(`  would run      : bun ${binPath} migrate --config ${cfg}`);
  console.log(`  then           : bun run scripts/verify-migrations.ts --through ${tag}`);

  if (plan) {
    // 🚫 Everything above happens in the real run too; this is where the two diverge, and nothing past this
    // point has happened. No connection has been opened — this script never imports a database driver.
    console.log("\n✅ --plan: nothing was applied and no database was contacted.");
  } else {
    // 🔴 TASK-268 — the resolved entry script, run with `bun`. 🚫 No `bunx`: it is a second resolution
    // nothing checked, and it can reach the network from a deploy step that should touch only the disk
    // and the database.
    const migrate = Bun.spawnSync(["bun", binPath, "migrate", "--config", cfg], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    if (migrate.exitCode !== 0) {
      console.error("\n✗ the partial migrate failed. Nothing in THIS run was committed (one transaction).");
      exitCode = migrate.exitCode ?? 1;
    } else {
      // §4 — this half ends in a verify too, scoped to what it was supposed to apply. An unscoped verify would
      // report the migrations this run deliberately left for the second command as failures, and a control that
      // cries wolf on its own instructions is a control people stop reading.
      const verify = Bun.spawnSync(["bun", "run", "scripts/verify-migrations.ts", "--through", tag], {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      });
      exitCode = verify.exitCode ?? 1;
      if (exitCode === 0) console.log(`\n✅ applied through ${tag}. Next: bun run db:migrate`);
    }
  }
} catch (e) {
  if ((e as Error).message !== "resolution") {
    console.error(`✗ db:migrate:through — ${(e as Error).message}`);
    console.error("  Nothing was applied. 🚫 There is deliberately no fallback to the full migration set.");
    exitCode = 1;
  }
} finally {
  // Every exit path, including failure — which is why nothing above calls `process.exit()` inside the try.
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(exitCode);
