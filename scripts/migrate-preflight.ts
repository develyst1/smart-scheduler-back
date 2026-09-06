// TASK-266 — 🔴 the PRE-migrate guard. **Exits non-zero when the pending set cannot be applied in one run.**
//
//   bun run db:preflight
//
// `db:migrate` runs this FIRST, so a batch that would fail halfway through can no longer be started. The
// decision itself lives in `src/lib/migrate-preflight.ts`, pure, so it is testable against the real migration
// files without a database.
//
// ## What it is for
// `sid`, 2026-09-06: `0032` adds the `'PAUSED'` enum label and `0033` uses it. `drizzle-kit migrate` applies
// every pending migration in ONE transaction, so the batch failed at the point of use. 🟢 It rolled back
// cleanly and cost nothing — because the owner insisted on `sid` before `uat`.
//
// 📌 The constraint was already written down, correctly, in `0032`'s header — and **the command that applies a
// migration never reads its comments.** @Porter: *"the requirement had no mechanism."* This is the mechanism.
//
// 🚫 It refuses and instructs; it never splits the batch itself. Silently doing two transactions where the
// operator asked for one is the same class of surprise as the one being fixed.
//
// ⚠️ It FAILS CLOSED. Anything it cannot determine — no database, an unreadable journal — exits non-zero.
// A preflight that waves the batch through when it cannot see is worse than no preflight, because the deploy
// note will say it ran.
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrationHash, missingMigrations, type LedgerRow, type OwnMigration } from "../src/lib/migration-ledger";
import { formatRefusal, scanBatch, type PendingMigration } from "../src/lib/migrate-preflight";

const OWN = "__drizzle_migrations_scheduling"; // must match drizzle.config.ts
const SCHEMA = "drizzle";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ db:preflight — DATABASE_URL required (it must know what is already applied).");
  process.exit(1);
}

const dir = resolve(import.meta.dir, "..", "drizzle");
const journal = JSON.parse(readFileSync(resolve(dir, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
// Journal ORDER is the whole basis of "a LATER migration uses it" — read as written, never sorted by anything
// else, and `readSql` is shared with the split runner so the two cannot disagree about a file's contents.
const sqlOf = (tag: string) => readFileSync(resolve(dir, `${tag}.sql`), "utf8");
const mine: OwnMigration[] = journal.entries.map((e) => ({
  tag: e.tag,
  when: e.when,
  hash: migrationHash(sqlOf(e.tag)),
}));

const sql = postgres(url);
try {
  const exists = await sql`
    SELECT 1 FROM information_schema.tables WHERE table_schema = ${SCHEMA} AND table_name = ${OWN}
  `;
  const rows = exists.length
    ? ((await sql`SELECT hash, created_at FROM ${sql(SCHEMA)}.${sql(OWN)}`) as unknown as LedgerRow[])
    : [];
  await sql.end();

  // PENDING = journal entries with no ledger row, in journal order. Same function `db:verify` uses, so
  // "pending" means one thing in both halves of the deploy step.
  const pending: PendingMigration[] = missingMigrations(mine, rows.map((r) => r.hash)).map((m) => ({
    tag: m.tag,
    sql: sqlOf(m.tag),
  }));

  console.log(`db:preflight — ${pending.length} pending migration(s): ${pending.map((p) => p.tag).join(", ") || "(none)"}`);

  const blockers = scanBatch(pending);
  if (!blockers.length) {
    console.log("✅ this batch can be applied in one run.");
    process.exit(0);
  }

  for (const line of formatRefusal(blockers)) console.error(line);
  console.error("\nNothing was applied.");
  process.exit(1);
} catch (e) {
  await sql.end().catch(() => {});
  console.error(`✗ db:preflight could not decide: ${(e as Error).message}`);
  console.error("  Refusing rather than guessing — a preflight that passes when it cannot see is not a control.");
  process.exit(1);
}
