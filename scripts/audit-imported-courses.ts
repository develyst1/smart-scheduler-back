// SPEC-060 / TASK-166 (REQ-064 requirement 6 / AC-7) — `courses:audit-imports`: which imported courses hold the
// wrong number of sessions. OWNER-RUN, on both boxes. **READ-ONLY.**
//
// 🔴 There is no `--commit`, and there never should be. Every course this lists belongs to a real family that has
// been told when their child's lessons are; removing one is the owner's decision, not a script's. TASK-165 stops
// the give-away from here on — this only sizes what the bug already did.
//
//   · NOTHING is written to the database. The only file written is the named report below.
//   · 🔴 PII: the console prints COUNTS ONLY. The per-course lines (with nicknames) go to gitignored
//     `project-docs/`, like every other audit in this repo.
//   · Run it on `sid` first, then `uat` — `uat` is the one with 16 imported courses on it.
import { eq, ne, and, inArray } from "drizzle-orm";
import { db } from "../src/db";
import { bookings, coursePackages, students } from "../src/db/schema";
import { courseCurrent } from "../src/lib/course-plan";
import { auditImportedCourses, auditSummary, type AuditCourseInput } from "../src/lib/import-course-audit";

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

async function main() {
  console.log("── courses:audit-imports · READ-ONLY (ไม่มีการเขียนใดๆ)");

  const courses = await db
    .select()
    .from(coursePackages)
    .where(eq(coursePackages.source, "IMPORT"));

  if (!courses.length) {
    console.log("  ไม่พบคอร์สที่นำเข้า (IMPORT) — ไม่มีอะไรต้องตรวจ");
    process.exit(0);
  }

  const ids = courses.map((c) => c.id);
  const rows = await db
    .select({
      id: bookings.id,
      courseId: bookings.courseId,
      status: bookings.status,
      date: bookings.date,
      extendedFromId: bookings.extendedFromId,
      bookingType: bookings.bookingType,
    })
    .from(bookings)
    .where(and(inArray(bookings.courseId, ids), ne(bookings.status, "CANCELLED")));

  const nick = new Map(
    (await db.select({ id: students.id, nickname: students.nickname }).from(students)).map((s) => [
      s.id,
      s.nickname,
    ]),
  );

  const input: AuditCourseInput[] = courses.map((c) => {
    const mine = rows.filter((r) => r.courseId === c.id);
    return {
      id: c.id,
      nickname: nick.get(c.studentId) ?? null,
      size: c.size,
      priorSessions: c.priorSessions,
      usedSessions: c.usedSessions,
      source: c.source,
      // 🔴 `courseCurrent` — the SAME counter the reconciler measures against, not a hand-rolled filter. An
      // audit that counted differently from the engine would report faults that aren't there and miss the ones
      // that are; it also inherits the SPEC-033 rule that a soft-linked extra never counts.
      liveCount: courseCurrent(mine as any),
      extendedCount: mine.filter((r) => r.bookingType === "COURSE_PACKAGE" && r.status === "EXTENDED").length,
    };
  });

  const findings = auditImportedCourses(input);
  const sum = auditSummary(findings);
  console.log(`  คอร์สนำเข้าทั้งหมด: ${courses.length}`);
  console.log(`  ผิดปกติ: ${sum.affected}  (เกิน ${sum.over} · ขาด ${sum.under})`);
  console.log(`  คาบที่เกินมารวม: ${sum.phantomSessions}`);

  const reportPath = arg("report") ?? "../project-docs/imported-course-audit.txt";
  await Bun.write(
    reportPath,
    [
      "รายงานตรวจคอร์สนำเข้า (REQ-064) — อ่านอย่างเดียว ไม่มีการแก้ไขใดๆ",
      `คอร์สนำเข้า ${courses.length} · ผิดปกติ ${sum.affected} (เกิน ${sum.over} · ขาด ${sum.under}) · คาบเกินรวม ${sum.phantomSessions}`,
      "",
      ...findings.map(
        (f) =>
          `${f.id} · ${f.nickname ?? "-"} · ซื้อ ${f.size} · เรียนมาก่อน ${f.priorSessions} ` +
          `(used ${f.usedSessions}) · แผนควรมี ${f.planSize} · มีจริง ${f.liveCount} ` +
          `(ขยาย ${f.extendedCount}) · ต่าง ${f.delta > 0 ? "+" : ""}${f.delta} → ${f.suggestion}`,
      ),
    ].join("\n"),
  );
  console.log(`  รายงานรายคอร์ส → ${reportPath}  (เก็บไว้ในเครื่อง ไม่ commit — มีชื่อเล่นนักเรียน)`);
  console.log("  ⚠️ รายงานนี้ไม่ได้แก้อะไร — การลบคาบต้องให้เจ้าของตัดสินใจเท่านั้น");
  process.exit(0);
}

if (import.meta.main) await main();
