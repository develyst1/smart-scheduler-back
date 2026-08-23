// SPEC-062 / TASK-177 (REQ-057) — remove exactly what one test course created. OWNER-RUN ONLY, `sid` first.
//
// Why this exists: the owner needs to test course creation on a live box and then take it back out — and doing
// that by hand in SQL on the customer's database is how a real family gets deleted at 6pm.
//
// Safety model (every line of it earned on this project):
//   · **ONE explicit `--course <id>`. Never a predicate** — no `--name`, no LIKE. A tool that can express
//     "everything like this" is eventually handed the wrong "this".
//   · **DRY RUN BY DEFAULT.** The blast radius is printed BY NAME, then the transaction is rolled back.
//   · **REFUSE, never warn** — an ATTENDED session, a posted sale, a LINE-linked parent or a multi-child parent
//     stops the run, and `--commit` does NOT override any of them: a warning on a delete tool is a delete that
//     happens anyway, at 6pm, by someone who has read it four times.
//   · **ONE transaction, explicit DELETE per table, FK order.** Never TRUNCATE CASCADE, never any DDL.
//   · Console only — the owner's terminal. This writes no file, because the radius names a child.
//
// Usage (env pointing at the target DB — `sid` first, then `uat`):
//   bun run course:cleanup --course <uuid>
//   bun run course:cleanup --course <uuid> --commit
//   bun run course:cleanup --course <uuid> --commit --remove-household
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/db";
import { boMovement, bookings, coursePackages, parents, students } from "../src/db/schema";
import {
  formatBlastRadius,
  planCourseCleanup,
  planHouseholdRemoval,
  type CleanupInput,
} from "../src/lib/course-cleanup-plan";

const arg = (name: string): string | undefined => {
  const eqForm = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eqForm) return eqForm.split("=").slice(1).join("=");
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const commit = process.argv.includes("--commit");
const removeHousehold = process.argv.includes("--remove-household");
const DRY_RUN_ROLLBACK = "__dry_run_rollback__";

async function main() {
  const courseId = arg("course");
  if (!courseId || courseId.startsWith("--")) {
    console.error("ต้องระบุ --course <id> (คอร์สเดียวเท่านั้น — เครื่องมือนี้ไม่รับเงื่อนไขค้นหา)");
    process.exit(1);
  }
  console.log(`-- course:cleanup - ${commit ? "COMMIT (ลบจริง)" : "DRY RUN (ไม่ลบอะไร)"} - course=${courseId}`);

  try {
    await db.transaction(async (tx: any) => {
      const course = await tx.query.coursePackages.findFirst({
        where: (c: any, { eq: e }: any) => e(c.id, courseId),
      });
      if (!course) throw new Error(`ไม่พบคอร์ส ${courseId}`);

      const rows = await tx.query.bookings.findMany({
        where: (b: any, { eq: e }: any) => e(b.courseId, courseId),
      });
      const student = await tx.query.students.findFirst({
        where: (s: any, { eq: e }: any) => e(s.id, course.studentId),
      });
      if (!student) throw new Error("คอร์สนี้ไม่มีนักเรียนผูกอยู่ - หยุดไว้ก่อน");
      const parent = student.parentId
        ? await tx.query.parents.findFirst({ where: (p: any, { eq: e }: any) => e(p.id, student.parentId) })
        : null;
      const siblings = parent
        ? await tx.query.students.findMany({ where: (s: any, { eq: e }: any) => e(s.parentId, parent.id) })
        : [];

      // A posted sale can hang off the course id (course sale) or any of its bookings (day-end revenue), so
      // both are checked — a delete that left either behind would leave the books pointing at nothing.
      const refIds = [courseId, ...rows.map((r: any) => r.id)];
      const posted = await tx
        .select({ refId: boMovement.refId })
        .from(boMovement)
        .where(and(eq(boMovement.refType, "SALE"), inArray(boMovement.refId, refIds)));

      const otherCourses = await tx.query.coursePackages.findMany({
        where: (c: any, { eq: e }: any) => e(c.studentId, student.id),
      });
      const otherVouchers = await tx.query.vouchers.findMany({
        where: (v: any, { eq: e }: any) => e(v.studentId, student.id),
      });
      const otherBookings = await tx.query.bookings.findMany({
        where: (b: any, { eq: e }: any) => e(b.studentId, student.id),
      });

      const input: CleanupInput = {
        course: {
          id: course.id,
          size: course.size,
          source: course.source,
          usedSessions: course.usedSessions,
          startDate: course.startDate,
        },
        bookings: rows.map((r: any) => ({ id: r.id, date: r.date, status: r.status })),
        student: { id: student.id, name: student.name, nickname: student.nickname ?? null },
        parent: parent
          ? {
              id: parent.id,
              name: parent.name,
              lineUserId: parent.lineUserId ?? null,
              studentCount: siblings.length,
            }
          : null,
        postedSaleRefIds: posted.map((p: any) => p.refId).filter(Boolean),
        // "Anything else" = a second course, any voucher, or a booking that is not part of this course.
        studentHasOtherEntitlements:
          otherCourses.some((c: any) => c.id !== courseId) ||
          otherVouchers.length > 0 ||
          otherBookings.some((b: any) => b.courseId !== courseId),
      };

      const plan = planCourseCleanup(input);
      for (const line of formatBlastRadius(input, plan)) console.log(`  ${line}`);

      if (!plan.ok) {
        console.error("\nปฏิเสธ - ไม่ลบอะไรทั้งสิ้น:");
        for (const r of plan.refusals) console.error(`   - ${r}`);
        // Thrown, not `process.exit`, so the transaction rolls back on the way out.
        throw new Error("REFUSED");
      }

      const household = removeHousehold ? planHouseholdRemoval(input) : null;
      if (household) {
        console.log(
          household.ok
            ? "  --remove-household: จะลบผู้ปกครอง + นักเรียนด้วย"
            : `  --remove-household: ไม่ลบครัวเรือน (${household.refusals.join(" / ")}) - แต่ยังลบคอร์สตามปกติ`,
        );
      }

      if (!commit) throw new Error(DRY_RUN_ROLLBACK);

      // FK order. `bookings.course_id` is `onDelete: SET NULL`, so deleting the course first would silently
      // ORPHAN its bookings rather than remove them — they must go explicitly, and first. Deleting a booking
      // cascades its `booking_badges` and set-nulls `notification_outbox`; nothing else hangs off it.
      await tx.delete(bookings).where(eq(bookings.courseId, courseId));
      await tx.delete(coursePackages).where(eq(coursePackages.id, courseId));

      if (household?.ok && parent) {
        await tx.delete(students).where(eq(students.id, student.id));
        await tx.delete(parents).where(eq(parents.id, parent.id));
      }
    });
  } catch (e: any) {
    if (e?.message === DRY_RUN_ROLLBACK) {
      console.log("\n  DRY RUN - ยังไม่ลบ. ตรวจรายการข้างบนแล้วรันซ้ำด้วย --commit");
      process.exit(0);
    }
    if (e?.message === "REFUSED") process.exit(1);
    console.error(`course:cleanup ไม่สำเร็จ - ไม่มีการเปลี่ยนแปลง (rollback): ${e?.message ?? e}`);
    process.exit(1);
  }

  console.log("\nลบเรียบร้อย - เฉพาะคอร์สนี้และคาบของมัน. รันซ้ำได้ (ครั้งที่สองจะไม่พบคอร์ส)");
  process.exit(0);
}

if (import.meta.main) await main();
