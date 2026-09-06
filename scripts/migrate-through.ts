// TASK-266 §4 — the SPLIT command. Apply the pending set **up to and including one tag**, then verify it.
//
//   bun run db:migrate:through 0032_booking_paused_status
//   bun run db:migrate                      # the rest, preflighted again
//
// 🔴 A refusal that leaves the operator stuck is a worse control than none. `db:preflight` prints exactly these
// two lines, so the person reading the refusal has the next command rather than a diagnosis.
//
// ## How it applies a subset without touching the real folder
// It writes a TEMPORARY migrations folder containing the journal entries up to `<tag>` and their `.sql` files
// **byte-for-byte**, plus a temporary drizzle config pointing at it, and then runs the ordinary
// `drizzle-kit migrate`. 🔑 Same tool, same transaction semantics, same ledger table — and because drizzle's
// ledger hash is the sha256 of the file TEXT, the rows it writes are identical to the ones the full command
// would have written. The second run then sees those migrations as applied and continues from there.
// 🚫 The real `drizzle/` folder is never modified. A deploy step that edits the thing it is deploying is how a
// half-finished run becomes unrecoverable.
//
// ⚠️ This is the one command that makes the batch NOT atomic — see the deploy note. Run 1 COMMITS. If run 2
// fails, `0032` stays applied and the database is in a state no single migration describes. That is the price
// of applying a set Postgres will not take in one transaction, and it must be stated rather than discovered.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { entriesThrough } from "../src/lib/migrate-preflight";

const tag = process.argv[2]?.trim();
if (!tag) {
  console.error("✗ db:migrate:through — a migration tag is required, e.g. 0032_booking_paused_status");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("✗ db:migrate:through — DATABASE_URL required.");
  process.exit(1);
}

const root = resolve(import.meta.dir, "..");
const dir = resolve(root, "drizzle");
const journal = JSON.parse(readFileSync(resolve(dir, "meta/_journal.json"), "utf8")) as {
  version?: string;
  dialect?: string;
  entries: Array<{ idx: number; tag: string; when: number }>;
};

let entries;
try {
  entries = entriesThrough(journal.entries, tag);
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "migrate-through-"));
try {
  mkdirSync(join(tmp, "meta"), { recursive: true });
  writeFileSync(join(tmp, "meta/_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  // Copied, never rewritten: the ledger hash is the sha256 of this text, so a single changed byte would make
  // the second run treat the migration as one it has never seen.
  for (const e of entries) copyFileSync(resolve(dir, `${e.tag}.sql`), join(tmp, `${e.tag}.sql`));

  const cfg = join(tmp, "drizzle.config.ts");
  writeFileSync(
    cfg,
    [
      'import { defineConfig } from "drizzle-kit";',
      "export default defineConfig({",
      `  schema: ${JSON.stringify(resolve(root, "src/db/schema.ts"))},`,
      `  out: ${JSON.stringify(tmp)},`,
      // The SAME ledger table as drizzle.config.ts — a partial run that recorded elsewhere would leave the
      // second run re-applying what it just did.
      '  migrations: { table: "__drizzle_migrations_scheduling", schema: "drizzle" },',
      '  dialect: "postgresql",',
      "  dbCredentials: { url: process.env.DATABASE_URL! },",
      "  casing: \"snake_case\",",
      "});",
      "",
    ].join("\n"),
  );

  console.log(`db:migrate:through ${tag} — applying ${entries.length} migration(s), up to and including ${tag}.`);
  const migrate = Bun.spawnSync(["bunx", "drizzle-kit", "migrate", "--config", cfg], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (migrate.exitCode !== 0) {
    console.error("\n✗ the partial migrate failed. Nothing in THIS run was committed (one transaction).");
    process.exit(migrate.exitCode ?? 1);
  }

  // §4 — this half ends in a verify too, scoped to what it was supposed to apply. An unscoped verify would
  // report the migrations this run deliberately left for the second command as failures, and a control that
  // cries wolf on its own instructions is a control people stop reading.
  const verify = Bun.spawnSync(["bun", "run", "scripts/verify-migrations.ts", "--through", tag], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (verify.exitCode !== 0) process.exit(verify.exitCode ?? 1);

  console.log(`\n✅ applied through ${tag}. Next: bun run db:migrate`);
  process.exit(0);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
