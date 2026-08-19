// SPEC-052 / TASK-151 (REQ-040) — clean-slate data reset. 🔴 OWNER-RUN ONLY, never by the team.
//
// Clears the test/demo records and keeps the school itself: teachers, subjects, badge config and app settings
// stay; schema and all three drizzle ledgers are never touched (no DDL anywhere in this file).
//
// Safety model (the reason this is a script and not hand-written SQL — REQ-040's own lesson):
//   · DRY RUN BY DEFAULT — counts + the plan, then ROLLBACK. Nothing is written without `--commit`.
//   · ONE transaction. Explicit DELETE per table in FK-restrict order — never TRUNCATE CASCADE.
//   · Before COMMIT it re-counts and asserts KEEP unchanged AND every CLEAR table = 0; any mismatch ROLLBACKs.
//   · Console prints COUNTS ONLY — no names, no phones, so the output is safe to paste back.
//
// Usage (from smart-scheduler-back, env pointing at the target DB — sid first, then uat):
//   bun run db:reset            # DRY RUN — shows what would go
//   bun run db:reset --commit   # actually clears
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import {
  CLEAR_TABLES,
  KEEP_TABLES,
  canCommit,
  formatCountTable,
  totalToClear,
  type Counts,
} from "../src/lib/db-reset-plan";

const commit = process.argv.includes("--commit");

/** A rolled-back dry run is signalled by throwing this — drizzle has no "rollback and continue". */
const DRY_RUN_ROLLBACK = "__dry_run_rollback__";

async function countAll(tx: any): Promise<Counts> {
  const counts: Counts = {};
  for (const t of [...KEEP_TABLES, ...CLEAR_TABLES]) {
    const rows = await tx.execute(sql.raw(`select count(*)::int as n from "${t}"`));
    counts[t] = Number((rows as any)[0]?.n ?? (rows as any).rows?.[0]?.n ?? 0);
  }
  return counts;
}

async function main() {
  console.log(`── db:reset · ${commit ? "COMMIT (จะลบจริง)" : "DRY RUN (ไม่เขียนอะไรทั้งสิ้น)"}`);

  let before: Counts = {};
  let after: Counts | undefined;
  try {
    await db.transaction(async (tx: any) => {
      before = await countAll(tx);
      console.log(formatCountTable(before));
      console.log(`  รวมแถวที่จะลบ: ${totalToClear(before)}`);

      if (!commit) throw new Error(DRY_RUN_ROLLBACK);

      for (const t of CLEAR_TABLES) {
        await tx.execute(sql.raw(`delete from "${t}"`)); // explicit DELETE, FK order — never TRUNCATE CASCADE
      }
      after = await countAll(tx);

      const verdict = canCommit(before, after);
      if (!verdict.ok) {
        console.error("🔴 ตรวจหลังลบไม่ผ่าน — ยกเลิกทั้งหมด (ROLLBACK):");
        for (const p of verdict.problems) console.error(`   - ${p}`);
        throw new Error("reset assertions failed → rolled back");
      }
    });
  } catch (e: any) {
    if (e?.message === DRY_RUN_ROLLBACK) {
      console.log("\n  DRY RUN — ไม่มีการลบ. ตรวจตัวเลขข้างบนแล้วรันซ้ำด้วย --commit");
      process.exit(0);
    }
    console.error(`✗ db:reset ล้มเหลว — ไม่มีการเปลี่ยนแปลง (rollback): ${e?.message ?? e}`);
    process.exit(1);
  }

  console.log("\n" + formatCountTable(before, after));
  console.log("✓ เคลียร์ข้อมูลเรียบร้อย — KEEP เท่าเดิมทุกตาราง, CLEAR = 0 ทุกตาราง, schema/ledger ไม่ถูกแตะ");
  console.log("  รันซ้ำได้ — ครั้งที่สองจะลบ 0 แถว (idempotent)");
  process.exit(0);
}

if (import.meta.main) await main();
