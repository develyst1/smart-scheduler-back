// SPEC-057 / TASK-157 (REQ-060 Part B.1) — repair gender/nationality on rows written BEFORE Part A. OWNER-RUN.
//
// Part A normalises on write, so every NEW child is fine. These are the ones it was too late for: rows still
// holding `Male` / `Thai`, which the product reads as "no gender" and "foreign". This fixes the stored casing so
// the customer never re-types — and it does it by **reusing `lib/demographics.ts`**, the same function the
// importer uses, so repair and import can never drift apart.
//
// Safety:
//   · DRY RUN BY DEFAULT — plan computed and reported, transaction rolled back. `--commit` writes.
//   · Writes ONLY `students.gender` / `students.nationality`, only for rows that actually change. Names, DOB,
//     courses, bookings, vouchers, quota, plans and LINE links are never read or written.
//   · A value that already normalises to itself is skipped, so the row staff fixed by hand is untouched with no
//     special case in the code.
//   · An unreadable stored value is LEFT and reported. The repair fixes casing; it never erases.
//   · 🔴 PII: the console prints COUNTS ONLY. The named per-row report goes to gitignored `project-docs/`.
//
// Usage (run on BOTH boxes):
//   bun run demographics:repair                       # DRY RUN
//   bun run demographics:repair --commit              # repair
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { students } from "../src/db/schema";
import { formatRepairCounts, formatRepairReport, planRepair, repairValues } from "../src/lib/demographics-repair";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const commit = process.argv.includes("--commit");
const DRY_RUN_ROLLBACK = "__dry_run_rollback__";

async function main() {
  console.log(`── demographics:repair · ${commit ? "COMMIT (เขียนจริง)" : "DRY RUN (ไม่เขียนอะไร)"}`);

  let reportLines: string[] = [];
  try {
    await db.transaction(async (tx: any) => {
      const rows = await tx
        .select({ id: students.id, name: students.name, gender: students.gender, nationality: students.nationality })
        .from(students);
      const plan = planRepair(rows);
      console.log(formatRepairCounts(plan)); // counts only — no student name ever reaches stdout
      reportLines = formatRepairReport(plan);

      if (!commit) throw new Error(DRY_RUN_ROLLBACK);
      for (const r of plan.toWrite) {
        await tx.update(students).set(repairValues(r)).where(eq(students.id, r.id));
      }
    });
  } catch (e: any) {
    if (e?.message !== DRY_RUN_ROLLBACK) {
      console.error(`✗ demographics:repair ไม่สำเร็จ — ไม่มีการเปลี่ยนแปลง (rollback): ${e?.message ?? e}`);
      process.exit(1);
    }
  }

  const reportPath = arg("report") ?? `../project-docs/demographics-repair-${commit ? "after" : "preview"}.txt`;
  await Bun.write(
    reportPath,
    [`รายงานแก้ข้อมูลเพศ/สัญชาติ (${commit ? "หลังแก้จริง" : "ตรวจก่อนแก้"})`, "", ...reportLines].join("\n"),
  );
  console.log(`  รายงานรายคน → ${reportPath}  (เก็บไว้ในเครื่อง ไม่ commit — มีชื่อนักเรียน)`);

  if (!commit) {
    console.log("  DRY RUN — ยังไม่แก้. อ่านรายงานแล้วรันซ้ำด้วย --commit");
    process.exit(0);
  }
  console.log("✓ แก้ไขเรียบร้อย — แตะเฉพาะคอลัมน์เพศ/สัญชาติ. รันซ้ำได้ (ครั้งที่สองจะพบ 0 รายการ)");
  console.log("  อย่าลืมรันทั้ง sid และ uat");
  process.exit(0);
}

if (import.meta.main) await main();
