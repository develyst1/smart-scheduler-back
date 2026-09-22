// TASK-437 (REQ-095 §13.4a) — `subjects:ensure`: the two seeded DUO programs carry `kind = DUO` (+ `price_group = balance-duo`,
// `active = true`), UPSERTED by exact name — an existing row (on `uat` both exist, and read PRIVATE after `0050`'s default) is
// UPDATED in place, never duplicated; a missing one is created; a correct one is left alone. The plan is pure
// (`planEnsureSubjects`, pinned by the suite); this file is the IO around it.
//
//   bun run subjects:ensure            # --dry-run (the default): prints the plan, writes NOTHING
//   bun run subjects:ensure --apply    # writes, in ONE transaction
//
// The human runs it once after `db:migrate` (verify 51). A name that does not match `uat`'s bytes shows as `create` in the
// dry-run — read the plan before `--apply`.
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { subjects } from "../src/db/schema";
import { DUO_SUBJECT_SEEDS, planEnsureSubjects } from "../src/lib/subject-kinds";

async function main() {
  const apply = process.argv.includes("--apply");
  const existing = await db.select({ name: subjects.name, kind: subjects.kind, priceGroup: subjects.priceGroup, active: subjects.active }).from(subjects);
  const plan = planEnsureSubjects(existing);
  console.log(`${apply ? "APPLY" : "DRY RUN"} — subjects:ensure (${existing.length} programs now)`);
  for (const p of plan) console.log(`  ${p.action === "create" ? "+" : p.action === "update" ? "~" : "="} ${p.name.padEnd(20)} ${p.action}${p.changes.length ? " — " + p.changes.join(", ") : ""}`);
  if (!apply) { console.log("DRY RUN — nothing written. Re-run with --apply."); return; }
  await db.transaction(async (tx) => {
    for (const p of plan) {
      const w = DUO_SUBJECT_SEEDS.find((s) => s.name === p.name)!;
      if (p.action === "create") await tx.insert(subjects).values({ name: w.name, kind: w.kind, priceGroup: w.priceGroup, active: true });
      else if (p.action === "update") await tx.update(subjects).set({ kind: w.kind, priceGroup: w.priceGroup, active: true }).where(eq(subjects.name, w.name));
    }
  });
  console.log(`applied: ${plan.filter((p) => p.action !== "unchanged").length} change(s).`);
}

if (import.meta.main) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
