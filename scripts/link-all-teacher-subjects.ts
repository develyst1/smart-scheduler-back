// SPEC-055 / TASK-155 (REQ-058 req 6) — `teacher-subjects:link-all`: link every non-archived teacher to every
// active program, in one owner-run command.
//
// 🔴 **`sid`-ONLY — or any box where open-by-default still holds. NEVER `uat`.** (Owner, 2026-08-29; TASK-223.)
//
// This header used to say the tool was owner-run on both boxes, and that open-by-default was a trade-off the
// owner had accepted. **Both statements are now false, and are not repeated here even as a quotation** — a grep
// for the revoked wording must find nothing in this repo. On `uat` the roster is **deliberately restricted** —
// the owner's words were *"ตั้งใจจำกัด"*: DC and Pop teach a chosen subset. A `--commit` there on 2026-08-29
// would have granted DC **16 programs he is not meant to teach**.
//
// 🔴 **And this tool can NEVER unlink.** That is what makes a wrong run expensive rather than merely wrong:
// undoing it is manual work in the product, one teacher × one program at a time, by someone who first has to
// work out which of the new links were the mistake. A bulk grant is one command; the repair is not.
//
// ⇒ **On `uat`, link a new program to a NAMED LIST** instead: insert-only, `ON CONFLICT DO NOTHING`, preceded by
// a `SELECT` that prints the exact names for the owner to read **before** anything is written. That is how the
// Surfskate & Skateboard program was added on 2026-08-29 — 26 teachers, DC deliberately excluded.
//
// 📌 The catch only surfaced because the dry run prints **per-teacher deltas** (`DC: +16 / =3` beside everyone
// else's `+1 / =18`). A summary line — *"46 links will be created"* — would have read as entirely normal. Keep
// the per-row output in anything that writes in bulk.
//
// Why a bulk command exists at all: `subjects:add --teacher` links one pair per invocation, and on a box where
// open-by-default holds that is 456 links. 456 hand-typed lines is not a runsheet, it is a half-finished roster
// waiting to happen — and a half-finished roster *looks* configured.
//
// Safety, same family as `db:reset` / `subjects:add`:
//   · DRY RUN BY DEFAULT — the full matrix is computed and printed, then the transaction is rolled back.
//   · `--commit` inserts with `onConflictDoNothing`; the composite PK `(teacher_id, subject_id)` makes a second
//     run create exactly 0 rows. Re-running is safe by construction, not by carefulness.
//   · Insert-only. No DDL. **Nothing is ever unlinked by this tool** — see the danger paragraph above; on a box
//     with a deliberately restricted roster that is not a trade-off, it is a one-way door.
//   · Console prints staff/catalogue names + counts. No student or parent data is read.
//
// Usage (`sid` only):
//   bun run teacher-subjects:link-all            # DRY RUN
//   bun run teacher-subjects:link-all --commit   # link
import { db } from "../src/db";
import { subjects, teacherSubjects, teachers } from "../src/db/schema";
import { formatBulkLinkPlan, planBulkLinks } from "../src/lib/bulk-link-plan";

const commit = process.argv.includes("--commit");
const DRY_RUN_ROLLBACK = "__dry_run_rollback__";

/**
 * TASK-223 item 3 — the revoked-policy warning, in the console rather than only in the file header.
 *
 * 🔴 Printed on **both** paths, dry run and `--commit` (SA correction at review): my first cut showed it only
 * on the dry run, and *"the person typing `--commit` is who it is for — a warning that vanishes at the moment
 * of danger fires only when it cannot matter."*
 *
 * Not exported: nothing imports it, and its test reads this file's source text rather than the module
 * (importing this script would construct the DB client).
 */
const UAT_WARNING =
  "⚠️  `uat`: the roster is deliberately restricted (owner 2026-08-29) — this tool is sid-only.\n" +
  "   It can NEVER unlink: undoing a wrong grant is manual work in the product, per teacher, per program.\n" +
  "   On `uat`, link a new program to a NAMED LIST after a SELECT the owner reads first.";

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
      // TASK-223 item 3 — the same rule as the file header, printed where the decision is actually made. The
      // person about to type `--commit` is reading THIS, not a header they opened weeks ago. On BOTH paths:
      // a warning that disappears exactly when someone is about to write is a warning that never fires.
      console.log(`\n${UAT_WARNING}`);
      console.log(formatBulkLinkPlan(plan));

      if (!commit) throw new Error(DRY_RUN_ROLLBACK);
      if (!plan.toCreate.length) return; // nothing to do — a re-run of a finished pass

      // One statement; the composite PK does the idempotency.
      await tx.insert(teacherSubjects).values(plan.toCreate).onConflictDoNothing();
    });
  } catch (e: any) {
    if (e?.message === DRY_RUN_ROLLBACK) {
      console.log("\n  DRY RUN — ยังไม่เขียน. ตรวจตัวเลขข้างบนแล้วรันซ้ำด้วย --commit (เฉพาะ sid)");
      process.exit(0);
    }
    console.error(`✗ teacher-subjects:link-all ไม่สำเร็จ — ไม่มีการเปลี่ยนแปลง (rollback): ${e?.message ?? e}`);
    process.exit(1);
  }

  console.log("✓ ผูกครูกับโปรแกรมเรียบร้อย — ครูที่ถูก archive และโปรแกรมที่ปิดใช้งานไม่ถูกผูก");
  // TASK-223: this line used to end by telling the operator to run it on both boxes — the revoked policy, in
  // the last words they read after a SUCCESSFUL run. (Not reproduced here: a grep for the old wording must find
  // nothing.) On `uat` the roster is deliberately restricted; a named list is how a program is added there.
  console.log("  รันซ้ำได้ — ครั้งที่สองจะสร้าง 0 ลิงก์ (idempotent). ห้ามรันบน uat — ที่นั่นต้องผูกตามรายชื่อที่เจ้าของอนุมัติ");
  process.exit(0);
}

if (import.meta.main) await main();
