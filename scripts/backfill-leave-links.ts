// TASK-553 (§2) — link the rows that ALREADY answer a leave without its link. OWNER-RUN, `sid` first, then `uat`.
// 🚫 No agent runs this anywhere: it is written, dry-run-reported, and handed to the owner.
//
//   · DRY RUN BY DEFAULT — the plan is computed inside a transaction, printed, then rolled back.
//   · Console = the three numbers (linked · ambiguous · not applicable) and the ambiguous ones by reason. The ids go to
//     gitignored `project-docs/` (no names — ids only).
//   · 🔑 Links ONLY on unique evidence (`lib/leave-link-backfill.ts`); an AMBIGUOUS row is left alone and counted.
//   · Writes only `extended_from_id`, and only on a row whose link is still NULL — a second run finds nothing to change.
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../src/db";
import { bookings, coursePackages } from "../src/db/schema";
import { backfillSummary, planLeaveLinkBackfill, type BackfillCourse } from "../src/lib/leave-link-backfill";

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const commit = process.argv.includes("--commit");
const DRY_RUN_ROLLBACK = "__dry_run_rollback__";

async function main() {
  console.log(`-- leave:backfill-links - ${commit ? "COMMIT (เขียนจริง)" : "DRY RUN (ไม่เขียนอะไร)"}`);
  let lines: string[] = [];
  try {
    await db.transaction(async (tx: any) => {
      // Only courses where some leave was ever answered by link — the only ones this can concern.
      const linkedRows = await tx.select({ courseId: bookings.courseId }).from(bookings).where(and(isNotNull(bookings.extendedFromId), isNotNull(bookings.courseId)));
      const courseIds = [...new Set(linkedRows.map((r: any) => r.courseId as string))];
      const courses = courseIds.length ? await tx.select({ id: coursePackages.id, createdAt: coursePackages.createdAt }).from(coursePackages).where(inArray(coursePackages.id, courseIds)) : [];
      const rows = courseIds.length
        ? await tx.select({ id: bookings.id, courseId: bookings.courseId, status: bookings.status, date: bookings.date, extendedFromId: bookings.extendedFromId, bookingType: bookings.bookingType, createdAt: bookings.createdAt })
            .from(bookings).where(inArray(bookings.courseId, courseIds))
        : [];
      const input: BackfillCourse[] = courses.map((c: any) => ({ id: c.id, createdAt: c.createdAt, rows: rows.filter((r: any) => r.courseId === c.id) }));
      const plan = planLeaveLinkBackfill(input);
      const sum = backfillSummary(plan);
      console.log(`  คอร์สที่ตรวจ: ${input.length}`);
      console.log(`  เชื่อมได้ (linked): ${sum.linked}`);
      console.log(`  กำกวม ไม่แตะ (ambiguous): ${sum.ambiguous}  (หลายการลา ${sum.ambiguousByReason["several-leaves"]} · หลายคาบที่อาจตอบ ${sum.ambiguousByReason["several-candidates"]} · ไม่พบคาบที่ตอบ ${sum.ambiguousByReason["no-candidate"]})`);
      console.log(`  ไม่เกี่ยว (not applicable): ${sum.notApplicable}`);
      lines = [
        `leave-link backfill (TASK-553) - ${commit ? "หลังแก้จริง" : "ตรวจก่อนแก้"}`,
        `linked ${sum.linked} · ambiguous ${sum.ambiguous} · not applicable ${sum.notApplicable}`,
        "",
        "== linked (course · row ← leave) ==",
        ...plan.link.map((l) => `${l.courseId} · ${l.rowId} ← ${l.leaveId}`),
        "",
        "== ambiguous — LEFT ALONE (course · leave · reason · candidates) ==",
        ...plan.ambiguous.map((a) => `${a.courseId} · ${a.leaveId} · ${a.reason} · ${a.candidates}`),
      ];
      if (!commit) throw new Error(DRY_RUN_ROLLBACK);
      for (const l of plan.link) {
        await tx.update(bookings).set({ extendedFromId: l.leaveId }).where(and(eq(bookings.id, l.rowId), isNull(bookings.extendedFromId)));
      }
    });
  } catch (e: any) {
    if (e?.message !== DRY_RUN_ROLLBACK) {
      console.error(`leave:backfill-links ไม่สำเร็จ - ไม่มีการเปลี่ยนแปลง (rollback): ${e?.message ?? e}`);
      process.exit(1);
    }
  }
  const reportPath = arg("report") ?? `../project-docs/leave-link-backfill-${commit ? "after" : "preview"}.txt`;
  await Bun.write(reportPath, lines.join("\n"));
  console.log(`  รายการ (id เท่านั้น) -> ${reportPath}`);
  if (!commit) {
    console.log("\n  DRY RUN - ยังไม่แก้. ส่งตัวเลขสามตัวนี้ให้ทีมตรวจก่อน แล้วค่อยรันซ้ำด้วย --commit");
    process.exit(0);
  }
  console.log("\n✓ เชื่อมเรียบร้อย - แตะเฉพาะ extended_from_id ที่ยังว่าง. รันซ้ำได้ (ครั้งที่สองจะพบ 0 รายการ)");
  process.exit(0);
}

if (import.meta.main) await main();
