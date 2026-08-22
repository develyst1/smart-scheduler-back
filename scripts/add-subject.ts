// SPEC-053 / TASK-153 (REQ-058) — `subjects:add`: create a program (and optionally link a teacher), OWNER-RUN.
//
// Why this exists: `subjects` rows were only ever created by `db/seed.ts`, so a live customer could not be given
// a new program without a deploy. This is that missing mechanism — nothing more. Everything else REQ-058 needed
// is already data: the booking modal lists `teacher.subjectOptions`, and price + voucher eligibility key off
// `price_group`, so a created row + a teacher link shows up in course / single / trial / voucher by construction.
//
// Safety, same family as `db:reset` / `import:students`:
//   · DRY RUN BY DEFAULT — plan printed, transaction rolled back, nothing written without `--commit`.
//   · INSERT-IF-MISSING only. An existing program is reported "already present — unchanged" and never touched,
//     so this tool structurally cannot rename, re-group or delete the nine existing programs (AC-5).
//   · The price group is validated against the real union before any write — a typo'd group would create an
//     unsellable program that still looks fine in the dropdown.
//   · One transaction, no DDL, console = catalogue names + counts (no student/parent data is read or written).
//
// Usage (sid first, then uat):
//   bun run subjects:add --name "Bike" --group bike-skate                      # DRY RUN
//   bun run subjects:add --name "Bike" --group bike-skate --commit             # create
//   bun run subjects:add --name "Bike" --group bike-skate --teacher ก้อง --commit
import { db } from "../src/db";
import { subjects, teacherSubjects } from "../src/db/schema";
import { formatSubjectAddPlan, planSubjectAdd } from "../src/lib/subject-add-plan";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const commit = process.argv.includes("--commit");
const DRY_RUN_ROLLBACK = "__dry_run_rollback__";

async function main() {
  const name = arg("name");
  const group = arg("group");
  const teacherQuery = arg("teacher");
  if (!name || !group) {
    console.error('✗ subjects:add — ต้องมี --name "<ชื่อโปรแกรม>" และ --group <bike-skate|onewheel|balance-private|balance-group>');
    process.exit(1);
  }

  console.log(`── subjects:add · ${commit ? "COMMIT (เขียนจริง)" : "DRY RUN (ไม่เขียนอะไร)"}`);

  try {
    await db.transaction(async (tx: any) => {
      const existing = await tx.select({ name: subjects.name }).from(subjects);
      const teachers = teacherQuery
        ? await tx.query.teachers.findMany({ columns: { id: true, nickname: true } })
        : [];
      const plan = planSubjectAdd({
        name,
        group,
        existingNames: existing.map((s: any) => s.name),
        teacherQuery,
        teachers,
      });
      console.log(formatSubjectAddPlan(plan));
      console.log(`  โปรแกรมทั้งหมดตอนนี้: ${existing.length}`);
      if (!plan.ok) throw new Error("refused before any write");
      if (!commit) throw new Error(DRY_RUN_ROLLBACK);

      if (plan.willCreate) {
        await tx
          .insert(subjects)
          .values({ name: plan.name, priceGroup: plan.group })
          .onConflictDoNothing({ target: subjects.name });
      }
      if (plan.link) {
        const row = await tx.query.subjects.findFirst({
          where: (s: any, { eq }: any) => eq(s.name, plan.name),
        });
        if (!row) throw new Error("โปรแกรมหายไประหว่างทำงาน — ยกเลิก");
        await tx
          .insert(teacherSubjects)
          .values({ teacherId: plan.link.id, subjectId: row.id })
          .onConflictDoNothing();
      }
    });
  } catch (e: any) {
    if (e?.message === DRY_RUN_ROLLBACK) {
      console.log("\n  DRY RUN — ยังไม่เขียน. ตรวจแผนข้างบนแล้วรันซ้ำด้วย --commit");
      process.exit(0);
    }
    console.error(`✗ subjects:add ไม่สำเร็จ — ไม่มีการเปลี่ยนแปลง (rollback): ${e?.message ?? e}`);
    process.exit(1);
  }

  console.log("✓ เรียบร้อย — โปรแกรมที่มีอยู่เดิมไม่ถูกแก้ไขหรือลบ (insert-if-missing เท่านั้น)");
  console.log("  รันซ้ำได้ — ครั้งที่สองจะรายงาน 'มีอยู่แล้ว — ไม่แก้ไข'");
  process.exit(0);
}

if (import.meta.main) await main();
