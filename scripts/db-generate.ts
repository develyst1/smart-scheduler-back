// TASK-495 — `bun run db:generate`: `drizzle-kit generate`, then the ONE entry it added is renumbered into our series.
//
// Usage (every drizzle-kit generate flag passes through):
//   bun run db:generate                       # a schema diff
//   bun run db:generate --custom --name x     # an empty, hand-written migration
//
// 🔴 `drizzle-kit generate` writes `when: +new Date()` (~1790…) — above our 1783… series — and drizzle skips every migration
// whose `when` is not above the ledger's newest row, IN SILENCE (TASK-085/494). This wrapper sets the new entry to the
// previous one + 1 and prints the change. The rules live in `src/lib/journal-series.ts` (pure, tested):
//  · it reads the journal BEFORE generate runs, and may touch ONLY the entry generate added in this run — every entry that
//    existed before must come back byte-identical, or it refuses. An entry born a moment ago cannot be applied anywhere.
//  · anything unexpected ⇒ it FAILS LOUDLY and writes nothing (the migration files drizzle wrote are left for you to look at;
//    TASK-494's test will also refuse the journal until it is fixed).
// 🚫 It never touches the database, `drizzle.config.ts`, or any migration file.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { JournalSeriesError, planSeriesRenumber } from "../src/lib/journal-series";

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith("--out="))?.slice(6) ?? (args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined);
const journalPath = resolve(outArg ?? "drizzle", "meta", "_journal.json");

let before: string;
try { before = readFileSync(journalPath, "utf8"); } catch {
  console.error(`[db:generate] 🔴 no journal at ${journalPath} — refusing to run: there is no series to follow.`);
  process.exit(1);
}

const gen = spawnSync("bunx", ["drizzle-kit", "generate", ...args], { stdio: "inherit", shell: process.platform === "win32" });
if (gen.status !== 0) process.exit(gen.status ?? 1);

try {
  const { text, changes } = planSeriesRenumber(before, readFileSync(journalPath, "utf8"));
  if (!changes.length) {
    // ⚠️ drizzle-kit can print an error and still exit 0 (seen: a missing snapshot) — so "no new entry" is said as what it is.
    console.log("[db:generate] journal `when`: nothing to renumber (no new entry — no schema change, or generate failed: read its output above).");
  } else {
    writeFileSync(journalPath, text);
    for (const c of changes) console.log(`[db:generate] ✅ ${c.tag}: when ${c.from} → ${c.to} (drizzle-kit writes Date.now(); our series is previous + 1)`);
  }
} catch (e) {
  if (!(e instanceof JournalSeriesError)) throw e;
  console.error(`[db:generate] 🔴 ${e.message}`);
  console.error("[db:generate]    drizzle applies a migration only if its `when` is ABOVE the ledger's newest row and skips the rest in silence — fix the journal by hand before committing (previous `when` + 1).");
  process.exit(1);
}
