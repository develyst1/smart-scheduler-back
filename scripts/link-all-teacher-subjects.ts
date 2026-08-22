// SPEC-055 / TASK-155 (REQ-058 req 6) — `teacher-subjects:link-all`: link every non-archived teacher to every
// active program, in one owner-run command. OWNER-RUN, on BOTH `sid` and `uat`.
//
// Why a bulk command exists at all: `subjects:add --teacher` links one pair per invocation, and the owner's
// choice ("every teacher can teach every program") is 456 links. 456 hand-typed lines is not a runsheet, it is a
// half-finished roster waiting to happen — and a half-finished roster *looks* configured.
//
// Safety, same family as `db:reset` / `subjects:add`:
//   · DRY RUN BY DEFAULT — the full matrix is computed and printed, then the transaction is rolled back.
//   · `--commit` inserts with `onConflictDoNothing`; the composite PK `(teacher_id, subject_id)` makes a second
//     run create exactly 0 rows. Re-running is safe by construction, not by carefulness.
//   · Insert-only. No DDL. Nothing is ever unlinked by this tool — pruning who *actually* teaches what is staff
//     work in the product, which is the trade-off the owner accepted when he chose open-by-default.
//   · Console prints staff/catalogue names + counts. No student or parent data is read.
//
// Usage (run on sid, then uat):
//   bun run teacher-subjects:link-all            # DRY RUN
//   bun run teacher-subjects:link-all --commit   # link
import { db } from "../src/db";
import { subjects, teacherSubjects, teachers } from "../src/db/schema";
import { formatBulkLinkPlan, planBulkLinks } from "../src/lib/bulk-link-plan";

const commit = process.argv.includes("--commit");
const DRY_RUN_ROLLBACK = "__dry_run_rollback__";

async function main() {
  console.log(`── teacher-subjects:link-all · ${commit ? "COMMIT (เขียนจริง)" : "DRY RUN (ไม่เขียนอะไร)"}`);

  try {
    await db.transaction(async (tx: any) => {
      const teacherRows = await tx
        .select({ id: teachers.id, nickname: teachers.nickname, archived: teachers.archived })
        .from(teachers);
      const subjectRows = await tx.select({ id: subjects.id, name: subjects.name, active: subjects.active }).from(subjects);
      const existing = await tx
        .select({ teacherId: teacherSubjects.teacherId, subjectId: teacherSubjects.subjectId })
        .from(teacherSubjects);

      const plan = planBulkLinks({ teachers: teacherRows, subjects: subjectRows, existingPairs: existing });
      console.log(formatBulkLinkPlan(plan));

      if (!commit) throw new Error(DRY_RUN_ROLLBACK);
      if (!plan.toCreate.length) return; // nothing to do — a re-run of a finished pass

      // One statement; the composite PK does the idempotency.
      await tx.insert(teacherSubjects).values(plan.toCreate).onConflictDoNothing();
    });
  } catch (e: any) {
    if (e?.message === DRY_RUN_ROLLBACK) {
      console.log("\n  DRY RUN — ยังไม่เขียน. ตรวจตัวเลขข้างบนแล้วรันซ้ำด้วย --commit");
      process.exit(0);
    }
    console.error(`✗ teacher-subjects:link-all ไม่สำเร็จ — ไม่มีการเปลี่ยนแปลง (rollback): ${e?.message ?? e}`);
    process.exit(1);
  }

  console.log("✓ ผูกครูกับโปรแกรมเรียบร้อย — ครูที่ถูก archive และโปรแกรมที่ปิดใช้งานไม่ถูกผูก");
  console.log("  รันซ้ำได้ — ครั้งที่สองจะสร้าง 0 ลิงก์ (idempotent). อย่าลืมรันทั้ง sid และ uat");
  process.exit(0);
}

if (import.meta.main) await main();
