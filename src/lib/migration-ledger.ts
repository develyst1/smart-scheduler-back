// TASK-085 — migration-ledger reasoning, kept pure so the dangerous decisions are testable WITHOUT a database.
//
// ## The outage this exists to prevent
// Neither repo set `migrationsTable`, so both wrote to the same default `drizzle.__drizzle_migrations`.
// drizzle's migrator (`pg-core/dialect`) does:
//
//     select id, hash, created_at from <ledger> order by created_at desc limit 1
//     if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) → apply
//
// **One row, compared by timestamp, never by hash.** Backoffice's newest `when` (1785542400000) is far above
// scheduling's entire journal (max 1783000000013), so scheduling's `db:migrate` applies **nothing and exits 0**
// — permanently, not just for 0015–0017.
//
// ## ⚠️ Why an empty new ledger is more dangerous than the bug
// `!lastDbMigration` → **every migration from 0000 re-applies** on a live database. So the new ledger must be
// SEEDED from the shared one before the first migrate. We copy what's already applied rather than guessing it.

import { createHash } from "node:crypto";

/** Exactly what drizzle stores: sha256 of the raw `.sql` file text. Same input ⇒ same hash, so a ledger row
 *  can be attributed to the repo that owns that file — no list of migration numbers to get wrong. */
export const migrationHash = (sqlText: string): string =>
  createHash("sha256").update(sqlText).digest("hex");

/**
 * 🔴 TASK-655 — ONE migration, TWO fingerprints.
 *
 * The ledger stores sha256 of the `.sql` file's TEXT, and the text differs by LINE ENDING: the repo stores LF, a Windows
 * checkout has CRLF. ⇒ **the same migration hashes differently depending on the machine that applied it**, and `db:verify`
 * hashes the file on the machine RUNNING it — so a migration recorded under the other ending reads MISSING and goes RED, and
 * `seed-ledger` "repairs" it by adding a second row. **sid went red with 48 doubles, uat green with 21; what decides it is the
 * running machine's ending, not the count.**
 * 🔑 It never makes drizzle SKIP anything — drizzle decides by the newest `created_at`, and both rows of a pair share one. A
 * red of this kind is ledger-only.
 *
 * ⚠️ **Normalise to LF BEFORE hashing**, then derive the CRLF form from that normalised text. A file with MIXED endings then
 * still yields exactly the two fingerprints drizzle could have written — hashing the raw text first would give a third that
 * matches nothing.
 */
export function migrationFingerprints(sqlText: string): { lf: string; crlf: string; all: readonly string[] } {
  const lfText = sqlText.replace(/\r\n/g, "\n");
  const lf = migrationHash(lfText);
  const crlf = migrationHash(lfText.replace(/\n/g, "\r\n"));
  return { lf, crlf, all: lf === crlf ? [lf] : [lf, crlf] };
}

export interface OwnMigration {
  tag: string;
  when: number;
  /** 🔑 TASK-655 — the LF fingerprint: the one every machine produces after `drizzle/*.sql text eol=lf`, and the one the seed WRITES. */
  hash: string;
  /**
   * 🔴 TASK-655 — BOTH fingerprints of this migration (LF and CRLF). 🚫 Not a second parallel list: it is built with `hash`
   * from the same text, by `migrationFingerprints`, so the two cannot drift.
   * ⚠️ It was OPTIONAL for one round, while `scripts/migrate-preflight.ts` sat outside the claim and still built a
   * single-hash `OwnMigration`. @Sober claimed that script and it now fills this too, so the field is REQUIRED:
   * 🔑 **an optional field that every caller fills is a trap for the next caller who does not.** The compiler is now the
   * thing that stops a fourth comparison being written on one fingerprint.
   */
  hashes: readonly string[];
}

/**
 * 🔴 TASK-655 — THE predicate every ledger comparison asks: is this migration recorded, under EITHER line ending?
 * 🔑 One rule, used by `missingMigrations`, by `verify`'s `ledgerLies` and by the seed's "already present" — because fixing
 * `missing` and leaving `ledgerLies` behind would silence the DANGEROUS case: a migration recorded under the other ending
 * whose schema is ABSENT would stop being flagged.
 * ✅ The legacy tag-as-hash rule is unchanged and still answers here.
 */
export const isRecorded = (m: OwnMigration, present: ReadonlySet<string>): boolean =>
  m.hashes.some((h) => present.has(h)) || present.has(m.tag);

export interface LedgerRow {
  hash: string;
  /** drizzle writes `folderMillis` here; `bigint` comes back as a string from postgres. */
  created_at: number | string;
}

export interface Attribution {
  /** Rows whose hash matches one of this repo's files — copy these across verbatim. */
  mine: Array<{ row: LedgerRow; tag: string; via: "hash" | "legacy-tag" }>;
  /** Rows that belong to the other repo, or that nothing here can explain. Never copied. */
  foreign: LedgerRow[];
}

/**
 * Split a shared ledger into "rows this repo owns" and "everything else", **by hash**.
 *
 * ⚠️ One real special case, found in the evidence rather than imagined: the legacy
 * `scripts/db-check-migrate.ts` recorded migrations with `hash` set to the **tag string**
 * (`'0004_teacher_work_days'`), not a sha256. Those rows are genuinely ours and must come across, or the
 * post-migrate verifier would report 0004/0005 as unrecorded forever. They're reported separately
 * (`via: "legacy-tag"`) so the operator can see they were matched by a different rule.
 */
export function attributeLedger(rows: LedgerRow[], mine: OwnMigration[]): Attribution {
  // 🔻 TASK-655 — EVERY fingerprint of each migration maps to its tag, so a row written under the other ending is still OURS.
  const byHash = new Map(mine.flatMap((m) => m.hashes.map((h) => [h, m.tag] as const)));
  const byTag = new Map(mine.map((m) => [m.tag, m.tag]));
  const out: Attribution = { mine: [], foreign: [] };

  for (const row of rows) {
    const byHashTag = byHash.get(row.hash);
    if (byHashTag) {
      out.mine.push({ row, tag: byHashTag, via: "hash" });
      continue;
    }
    const legacyTag = byTag.get(row.hash);
    if (legacyTag) {
      out.mine.push({ row, tag: legacyTag, via: "legacy-tag" });
      continue;
    }
    out.foreign.push(row);
  }
  return out;
}

/** Rows to insert, skipping anything the target ledger already has — so the seed is safe to re-run. */
export function rowsToInsert(
  attributed: Attribution["mine"],
  alreadyPresentHashes: Iterable<string>,
): Attribution["mine"] {
  const present = new Set(alreadyPresentHashes);
  return attributed.filter((a) => !present.has(a.row.hash));
}

/**
 * 🔴 The guard. Journal entries with no row in this repo's ledger — i.e. migrations that did **not** apply.
 *
 * A deploy step that cannot fail visibly is not a control. This is what makes the next skipped migration a
 * red failure instead of a green deploy.
 */
export function missingMigrations(mine: OwnMigration[], ledgerHashes: Iterable<string>): OwnMigration[] {
  const present = new Set(ledgerHashes);
  // 🔻 TASK-655 — missing only if NEITHER fingerprint is there. One predicate, shared with `verify`'s `ledgerLies`.
  return mine.filter((m) => !isRecorded(m, present));
}

/**
 * Would drizzle actually apply this migration, given the ledger's newest `created_at`? Mirrors the migrator's
 * own condition, so we can explain a silent skip instead of only detecting it.
 */
export const wouldApply = (m: OwnMigration, newestCreatedAt: number | null): boolean =>
  newestCreatedAt === null || newestCreatedAt < m.when;

/** The newest `created_at` in a ledger — the single value drizzle's decision hangs on. */
export function newestCreatedAt(rows: LedgerRow[]): number | null {
  if (rows.length === 0) return null;
  return Math.max(...rows.map((r) => Number(r.created_at)));
}
