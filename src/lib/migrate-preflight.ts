// TASK-266 — 🔴 **`db:migrate` must REFUSE a batch it cannot apply, instead of failing inside it.**
//
// ## The incident, in one line
// `SPEC-075` §2 said *"a new enum value cannot be USED in the transaction that adds it ⇒ two migrations."* The
// Postgres half was right; the tool half was not. **`drizzle-kit migrate` applies every pending migration in ONE
// transaction**, so two files are not two transactions — the requirement was two **RUNS**. `0032` adds `'PAUSED'`
// and `0033` uses it, and `sid` refused the batch at the point of use.
//
// ## Why this file exists rather than a better comment
// @Porter: *"the requirement had no mechanism. 'Must be applied as a separate run' lives in a comment inside the
// file being applied, and the command that applies it never reads it."*
// 📌 **The fact was already correct in the repo** — `0029`'s own header states the one-transaction behaviour
// exactly, and `0029` stayed safe by never referencing `'OTHER'` in its own batch. **A note is not a mechanism:**
// the note was right, was written by us, and did not stop this.
// 📌 `db:verify` is the precedent and says it in its own header — *"a deploy step that cannot fail visibly is not
// a control."* This is that, one step earlier.
//
// ## 🚫 It is deliberately not clever
// It does not parse SQL. It finds one `ADD VALUE '<label>'` and one LATER mention of the same quoted label.
// A narrow rule that fires is worth more than a general one somebody switches off.

/** One pending migration, in journal order. `sql` is the raw file text. */
export interface PendingMigration {
  tag: string;
  sql: string;
}

/**
 * 🔴 Comments are stripped before anything is matched, and this is load-bearing rather than tidiness.
 *
 * `0029`'s header contains the words `ALTER TYPE … ADD VALUE` and `'OTHER'` in prose, and `0032`'s header
 * explains `'PAUSED'` at length. A preflight that read comments would refuse batches that are fine and would
 * eventually be switched off — which is exactly the fate §3 warns about. Same trap the source-assertion tests
 * hit repeatedly: comment text is prose, not behaviour.
 */
export const stripSqlComments = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** A pair that cannot share a transaction: `adds` introduces `label`, `uses` references it later. */
export interface EnumSplit {
  kind: "enum-label";
  label: string;
  /** The migration that ADDs the label — the last one the first run may include. */
  adds: string;
  /** The first later migration that references it. */
  uses: string;
}

/**
 * A statement Postgres refuses inside a transaction block **at all** — so no split can rescue it and
 * `drizzle-kit migrate` cannot apply it by any route.
 */
export interface NonTransactional {
  kind: "non-transactional";
  tag: string;
  statement: string;
}

export type Blocker = EnumSplit | NonTransactional;

/**
 * ⚠️ Q1's sweep, and it came back with one more class than the task named.
 *
 * These cannot run inside a transaction block on any supported server, so they are not a "split it into two
 * runs" problem — they are "this tool cannot apply this file". **None is present in our migrations today**
 * (`0033`'s header rules `CREATE INDEX CONCURRENTLY` out explicitly, on lock grounds), which is exactly why the
 * check is cheap to add now and expensive to add after the first one lands.
 *
 * 🚫 Not a general SQL understanding — a literal list of five words, and each one is here because Postgres
 * documents it as unusable in a transaction block.
 */
const NON_TRANSACTIONAL = [
  "CONCURRENTLY", // CREATE/DROP INDEX … CONCURRENTLY, REINDEX … CONCURRENTLY
  "VACUUM",
  "ALTER SYSTEM",
  "CREATE DATABASE",
  "DROP DATABASE",
] as const;

const ADD_VALUE = /ALTER\s+TYPE\s+[^;]*?\bADD\s+VALUE\b[^;]*?'([^']+)'/gi;

/**
 * Everything in `pending` that stops it being applicable in one `drizzle-kit migrate`.
 *
 * `pending` must be in **journal order** — "a LATER migration uses it" is an ordering claim, and an unordered
 * input would silently answer a different question.
 */
export function scanBatch(pending: readonly PendingMigration[]): Blocker[] {
  const code = pending.map((m) => ({ tag: m.tag, sql: stripSqlComments(m.sql) }));
  const blockers: Blocker[] = [];

  for (const [i, m] of code.entries()) {
    for (const word of NON_TRANSACTIONAL) {
      if (new RegExp(`\\b${word.replace(/ /g, "\\s+")}\\b`, "i").test(m.sql)) {
        blockers.push({ kind: "non-transactional", tag: m.tag, statement: word });
      }
    }

    ADD_VALUE.lastIndex = 0;
    for (const match of m.sql.matchAll(ADD_VALUE)) {
      const label = match[1]!;
      // ⚠️ Only LATER files. A migration that adds a label and uses it in the same FILE is the same defect, but
      // it is not one this preflight can fix by splitting — and we have never written one. Reported as the
      // enum pair only when a split would actually help, so the printed instruction is always true.
      const uses = code.slice(i + 1).find((later) => later.sql.includes(`'${label}'`));
      if (uses) blockers.push({ kind: "enum-label", label, adds: m.tag, uses: uses.tag });
    }
  }
  return blockers;
}

/**
 * The refusal the operator reads at 11pm on a live box.
 *
 * 🔴 It prints the NEXT COMMAND, not a diagnosis. A control that explains the problem and leaves someone stuck
 * is a worse control than none — they will work around it, and the workaround is `drizzle-kit migrate` typed by
 * hand, which is the thing this exists to prevent.
 */
export function formatRefusal(blockers: readonly Blocker[]): string[] {
  const out: string[] = [];
  const enums = blockers.filter((b): b is EnumSplit => b.kind === "enum-label");
  const hard = blockers.filter((b): b is NonTransactional => b.kind === "non-transactional");

  for (const b of hard) {
    out.push(
      `✗ ${b.tag} contains ${b.statement}, which Postgres refuses inside a transaction block.`,
      `  \`drizzle-kit migrate\` cannot apply it at all — no split helps. This one needs a human and a plan.`,
    );
  }

  if (enums.length) {
    // The first pair decides the split point: applying THROUGH the earliest `adds` is always safe, and the
    // second run re-runs this same preflight on what is left.
    const first = enums.reduce((a, b) => (a.adds <= b.adds ? a : b));
    out.push(
      `✗ this batch cannot be applied in one run: ${first.uses} uses '${first.label}', which ${first.adds} adds.`,
      `  A new enum value cannot be USED in the transaction that adds it, and \`drizzle-kit migrate\` applies`,
      `  every pending migration in ONE transaction. Two files are not two transactions — this needs two RUNS.`,
      ``,
      `  run:  bun run db:migrate:through ${first.adds}`,
      `  then: bun run db:migrate            (applies the rest, and re-runs this check)`,
    );
    for (const b of enums.slice(1)) {
      out.push(`  (also: ${b.uses} uses '${b.label}' from ${b.adds} — the second run will stop there too.)`);
    }
  }
  return out;
}

/**
 * 🔴 TASK-267 — **node's own resolution algorithm, reproduced**, because nothing else reproduces the bug.
 *
 * `db:migrate:through` writes a drizzle config whose first line is `import … from "drizzle-kit"`, and
 * drizzle-kit loads that config from ITS OWN path. When the config sat in the OS temp folder, resolution
 * walked up from `C:Users…Temp`, never reached this repo's `node_modules`, and the owner got
 * `Cannot find module 'drizzle-kit'` on `sid`.
 *
 * ⚠️ **`Bun.resolveSync` cannot stand in for this and I checked rather than assumed:** from the OS temp
 * folder it succeeds, returning `~/.bun/install/cache/drizzle-kit@…`. A probe that passes on the broken
 * arrangement is a comfort, not a control — it would have printed a ✓ over the exact failure.
 *
 * So this walks directories upward looking for `node_modules/<pkg>`, which is what node (and therefore
 * esbuild, and therefore drizzle-kit's config loader) actually does.
 */
export function resolvesByNodeWalk(
  fromDir: string,
  pkg: string,
  exists: (path: string) => boolean,
): string | null {
  // ⚠️ No regex, and both separators: the first attempt used a forward-slash-only character class and, on
  // Windows, never stripped a parent — so it reported "not reachable" from INSIDE the repo. A resolution
  // check that fails on the correct arrangement is as useless as one that passes on the broken one.
  let dir = fromDir;
  for (;;) {
    if (exists(`${dir}/node_modules/${pkg}`)) return `${dir}/node_modules/${pkg}`;
    const cut = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
    if (cut <= 0) return null; // filesystem root, or a bare drive letter
    const parent = dir.slice(0, cut);
    if (parent === dir) return null;
    dir = parent;
  }
}
/** The journal entries a `--through <tag>` run may apply: everything up to and including `tag`, in order. */
export function entriesThrough<T extends { tag: string }>(entries: readonly T[], tag: string): T[] {
  const at = entries.findIndex((e) => e.tag === tag);
  if (at < 0) throw new Error(`no migration tagged ${tag} in the journal`);
  return entries.slice(0, at + 1);
}
