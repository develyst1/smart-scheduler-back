// TASK-085 — 🔴 the post-migrate guard. **Exits non-zero when a journal entry has no ledger row.**
//
//   bun run db:verify
//
// `db:migrate` is wired to run this straight after, so a migrate that silently applied nothing can no longer
// be mistaken for a successful deploy.
//
// ## Why this exists
// This is the fourth time in two days that **silence + exit 0** reached production: `void recordSale`, the
// unregistered scheduled jobs, the swallowed `400`, and now three skipped migrations. A deploy step that
// cannot fail visibly is not a control. The ledger split fixes today's breakage; this is what makes the *next*
// one a red failure instead of a green deploy.
//
// Replaces `scripts/db-check-migrate.ts`, which was hardcoded to two 2026-era columns and — worse — recorded
// migrations with `hash` set to the tag string, creating the unattributable rows this task had to special-case.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  migrationHash,
  missingMigrations,
  newestCreatedAt,
  wouldApply,
  type LedgerRow,
  type OwnMigration,
} from "../src/lib/migration-ledger";
import { SCHEDULING_WITNESSES as WITNESSES, judge } from "../src/lib/migration-witness";
import { probeAll } from "./probe-witnesses";

const OWN = "__drizzle_migrations_scheduling"; // must match drizzle.config.ts
const SCHEMA = "drizzle";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const sql = postgres(url);

const dir = resolve(import.meta.dir, "..", "drizzle");
const journal = JSON.parse(readFileSync(resolve(dir, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const mine: OwnMigration[] = journal.entries.map((e) => ({
  tag: e.tag,
  when: e.when,
  hash: migrationHash(readFileSync(resolve(dir, `${e.tag}.sql`), "utf8")),
}));

const exists = await sql`
  SELECT 1 FROM information_schema.tables WHERE table_schema = ${SCHEMA} AND table_name = ${OWN}
`;
const rows = exists.length
  ? ((await sql`SELECT hash, created_at FROM ${sql(SCHEMA)}.${sql(OWN)}`) as unknown as LedgerRow[])
  : [];

const missing = missingMigrations(mine, rows.map((r) => r.hash));

// TASK-086 — the ledger is only half the question. Ask the SCHEMA too, using the **same witness map** the
// seeder uses (imported, not re-stated), so the two cannot form different notions of "applied". If they
// could disagree we'd eventually get a green verify on a broken database — worse than today, because today
// it is at least red.
const witnessed = judge(WITNESSES, await probeAll(sql, WITNESSES));
await sql.end();

const notInSchema = witnessed.filter((w) => w.verdict !== "applied");
const ledgerHashes = new Set(rows.map((r) => r.hash));
const hashOf = new Map(mine.map((m) => [m.tag, m.hash]));
// 🔴 The dangerous disagreement: the ledger says applied, the database says it isn't.
const ledgerLies = notInSchema.filter((w) => ledgerHashes.has(hashOf.get(w.tag) ?? ""));

console.log(`Journal: ${mine.length} migration(s) · ledger ${SCHEMA}.${OWN}: ${rows.length} row(s)`);
console.log(`Schema witnesses: ${witnessed.filter((w) => w.verdict === "applied").length} applied`);

if (missing.length === 0 && ledgerLies.length === 0) {
  console.log("✅ every migration is recorded in the ledger AND witnessed in the schema.");
  process.exit(0);
}

if (ledgerLies.length) {
  console.error(
    `\n🔴 ${ledgerLies.length} migration(s) are RECORDED AS APPLIED but the schema says otherwise:\n`,
  );
  for (const w of ledgerLies) {
    console.error(`  ${w.tag.padEnd(34)} ${w.verdict}  ·  ${w.probe} → found=${w.found === null ? "n/a" : w.found}`);
    console.error(`    ${w.why}`);
  }
  console.error(
    "\n  A ledger row without the schema to back it is the failure this whole task exists to end.\n" +
      "  Do NOT restart the app. Run `bun run db:seed-ledger` (dry-run) and send the output.",
  );
}

if (missing.length === 0) {
  console.error("\nDeploy is NOT complete.");
  process.exit(1);
}

// Explain WHY, not just THAT — a silent skip and a genuinely failed statement look identical otherwise.
const newest = newestCreatedAt(rows);
console.error(`\n🔴 ${missing.length} migration(s) in the journal are NOT recorded as applied:\n`);
for (const m of missing) {
  const silent = !wouldApply(m, newest);
  console.error(
    `  ${m.tag.padEnd(34)} when=${m.when}` +
      (silent
        ? `  ⚠️ drizzle would SKIP this silently (ledger newest created_at=${newest} ≥ when)`
        : "  (drizzle would apply it — did migrate run?)"),
  );
}
if (missing.some((m) => !wouldApply(m, newest))) {
  console.error(
    "\n⚠️ A skip means this repo's ledger contains a row NEWER than these migrations — the TASK-085 failure" +
      "\n   mode. Check `migrationsTable` in drizzle.config.ts and run `bun run db:seed-ledger`.",
  );
}
console.error("\nDeploy is NOT complete. Do not restart the app against this schema.");
process.exit(1); // 🔴 the whole point
