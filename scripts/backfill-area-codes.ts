// TASK-800 (REQ-118) — the OWNER-RUN backfill of `parents.province_code / district_code / subdistrict_code` from what the system already holds.
//
//   bun run scripts/backfill-area-codes.ts            ← DRY RUN (the default): reads, decides, PRINTS. Writes NOTHING.
//   bun run scripts/backfill-area-codes.ts --apply     ← writes the matched codes, in ONE transaction.
//
// The rules live in `src/lib/area-backfill.ts` (pure, pinned by value): province code by EXACT name (one of the 77) · district + sub-district ONLY from a note line that is EXACTLY our doors' format AND
// resolves to ONE code triple · everything else stays NULL and is LISTED with a reason. 🚫 No guessing. The note and `province` are NEVER changed. Idempotent: a parent that already holds codes is skipped.
// The output is IDS and REASONS only — no names, no phones, no note text.
//
// ⚠️ It reads and (with --apply) writes the database `DATABASE_URL` points at — the owner runs it, on purpose, after reading the dry run. Agents never do.
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../src/db";
import { parents } from "../src/db/schema";
import { loadGeography } from "../src/lib/area-codes";
import { planBackfill, type BackfillRow } from "../src/lib/area-backfill";

const apply = process.argv.includes("--apply");
const geo = loadGeography();
const rows: BackfillRow[] = await db
  .select({ id: parents.id, province: parents.province, note: parents.note, provinceCode: parents.provinceCode, districtCode: parents.districtCode, subdistrictCode: parents.subdistrictCode })
  .from(parents)
  .where(isNull(parents.archivedAt)); // ACTIVE parents only
const plan = planBackfill(rows, geo);

console.log(`${apply ? "APPLY" : "DRY RUN"} — active parents ${plan.counts.parents} · skipped (already hold codes) ${plan.counts.skippedAlreadyHaveCodes}`);
console.log(`would set: province code ${plan.counts.provinceCodes} · full triple (province + district + sub-district) ${plan.counts.fullTriples}`);
console.log("not matched at the district/sub-district level, or not at all — by reason:");
for (const [reason, n] of Object.entries(plan.counts.unmatched)) console.log(`  ${reason.padEnd(24)} ${n}`);
console.log(`\nLISTED (parent id · reason) — ${plan.unmatched.length}:`);
for (const u of plan.unmatched) console.log(`  ${u.id}  ${u.reason}`);

if (!apply) { console.log("\n(dry run — nothing was written. Re-run with --apply to write.)"); process.exit(0); }

let written = 0;
await db.transaction(async (tx) => {
  for (const d of plan.decisions) {
    if (d.action !== "write") continue;
    // the WHERE re-asserts «still no codes» — a parent whose codes arrived since the read (a door) is left alone, and a re-run writes nothing
    const res = await tx
      .update(parents)
      .set({ provinceCode: d.provinceCode, districtCode: d.districtCode, subdistrictCode: d.subdistrictCode })
      .where(and(eq(parents.id, d.id), isNull(parents.provinceCode), isNull(parents.districtCode), isNull(parents.subdistrictCode), isNotNull(parents.province)))
      .returning({ id: parents.id });
    written += res.length;
  }
});
console.log(`\nAPPLIED — ${written} parent(s) updated, in one transaction. The note and province were not touched.`);
process.exit(0);
