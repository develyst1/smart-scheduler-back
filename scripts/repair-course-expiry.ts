// FIX-007 / TASK-195 — recompute `course_packages.expiry_date` from the rule that should have set it.
// OWNER-RUN, `sid` first, then `uat`.
//
// 🔴 **Read the dry-run list before you commit this one.** Course expiry now decides whether a family reads as
// `EXPIRED` on the course list, and some imported courses will legitimately flip the moment this runs. The
// report names them so that is the owner's decision, taken in advance — not a discovery the next morning.
//
//   · DRY RUN BY DEFAULT — the plan is computed inside a transaction, printed, then rolled back.
//   · Console = COUNTS ONLY. The by-name list (student nicknames + both dates) goes to gitignored
//     `project-docs/`, per the standing PII rule.
//   · AC-4: a course whose last LIVE session sits after its corrected expiry is FLAGGED, never moved.
//   · Idempotent: a second run finds nothing to change.
import { eq, ne, and, inArray } from "drizzle-orm";
import { db } from "../src/db";
import { bookings, coursePackages, students } from "../src/db/schema";
import { bangkokNow } from "../src/lib/bangkok-time";
import { COURSE_LIVE_STATUSES } from "../src/lib/course-plan";
import { planExpiryRepair, repairSummary, type RepairCourse } from "../src/lib/expiry-repair-plan";

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const commit = process.argv.includes("--commit");
const DRY_RUN_ROLLBACK = "__dry_run_rollback__";

async function main() {
  const today = bangkokNow().date;
  console.log(`-- course:repair-expiry - ${commit ? "COMMIT (เขียนจริง)" : "DRY RUN (ไม่เขียนอะไร)"} - ${today}`);
  let lines: string[] = [];

  try {
    await db.transaction(async (tx: any) => {
      const courses = await tx.select().from(coursePackages);
      const nick = new Map(
        (await tx.select({ id: students.id, nickname: students.nickname }).from(students)).map(
          (s: any) => [s.id, s.nickname],
        ),
      );

      // The last LIVE session per course — AC-4's input. One query for every course, not one per course.
      const live = courses.length
        ? await tx
            .select({ courseId: bookings.courseId, date: bookings.date })
            .from(bookings)
            .where(
              and(
                inArray(bookings.courseId, courses.map((c: any) => c.id)),
                inArray(bookings.status, COURSE_LIVE_STATUSES as unknown as string[]),
                ne(bookings.bookingType, "SINGLE_SESSION"),
              ),
            )
        : [];
      const lastLive = new Map<string, string>();
      for (const r of live) {
        if (!r.courseId) continue;
        const cur = lastLive.get(r.courseId);
        if (!cur || r.date > cur) lastLive.set(r.courseId, r.date);
      }

      const input: RepairCourse[] = courses.map((c: any) => ({
        id: c.id,
        nickname: nick.get(c.studentId) ?? null,
        source: c.source,
        size: c.size,
        priorSessions: c.priorSessions ?? 0,
        startDate: c.startDate,
        expiryDate: c.expiryDate,
        lastLiveSessionDate: lastLive.get(c.id) ?? null,
      }));

      const changes = planExpiryRepair(input, today);
      const sum = repairSummary(changes);
      // 🔴 TASK-200: the skipped count is printed, not implied. The owner asked for imports to be left alone —
      // he should be able to SEE that they were, on the line above the numbers he is about to commit, rather
      // than trust that a filter he cannot see is doing its job.
      const skippedImports = input.filter((c) => c.source === "IMPORT").length;
      console.log(`  คอร์สทั้งหมด: ${courses.length}`);
      console.log(`  ข้ามคอร์สนำเข้า (IMPORT) ไม่แตะเลย: ${skippedImports}`);
      console.log(`  ต้องแก้วันหมดอายุ: ${sum.changed}  (เร็วขึ้น ${sum.earlier} · ช้าลง ${sum.later})`);
      console.log(`  🔴 จะกลายเป็นหมดอายุทันที: ${sum.newlyExpired}`);
      console.log(`  ⚠️ มีคาบที่ยังไม่เรียนอยู่หลังวันหมดอายุใหม่: ${sum.liveSessionPastExpiry}`);

      lines = [
        `รายงานแก้วันหมดอายุคอร์ส (FIX-007) - ${commit ? "หลังแก้จริง" : "ตรวจก่อนแก้"} - ${today}`,
        `คอร์สทั้งหมด ${courses.length} · ข้าม IMPORT ${skippedImports} · แก้ ${sum.changed} · หมดอายุทันที ${sum.newlyExpired} · มีคาบเลยวันหมดอายุ ${sum.liveSessionPastExpiry}`,
        "",
        "== จะกลายเป็นหมดอายุทันที (อ่านส่วนนี้ก่อน) ==",
        ...changes
          .filter((x) => x.newlyExpired)
          .map((x) => `${x.nickname ?? "-"} · ${x.source} · ${x.from} -> ${x.to}`),
        "",
        "== เปลี่ยนวันหมดอายุ (ยังไม่หมดอายุ) ==",
        ...changes
          .filter((x) => !x.newlyExpired)
          .map((x) => `${x.nickname ?? "-"} · ${x.source} · ${x.from} -> ${x.to}`),
        "",
        "== มีคาบที่ยังไม่เรียนอยู่หลังวันหมดอายุใหม่ (ต้องให้คนตัดสินใจ - สคริปต์ไม่แตะ) ==",
        ...changes
          .filter((x) => x.liveSessionPastExpiry)
          .map((x) => `${x.nickname ?? "-"} · คาบล่าสุด ${x.liveSessionPastExpiry} · หมดอายุใหม่ ${x.to}`),
      ];

      if (!commit) throw new Error(DRY_RUN_ROLLBACK);
      for (const ch of changes) {
        await tx
          .update(coursePackages)
          .set({ expiryDate: ch.to })
          .where(eq(coursePackages.id, ch.id));
      }
    });
  } catch (e: any) {
    if (e?.message !== DRY_RUN_ROLLBACK) {
      console.error(`course:repair-expiry ไม่สำเร็จ - ไม่มีการเปลี่ยนแปลง (rollback): ${e?.message ?? e}`);
      process.exit(1);
    }
  }

  const reportPath = arg("report") ?? `../project-docs/course-expiry-repair-${commit ? "after" : "preview"}.txt`;
  await Bun.write(reportPath, lines.join("\n"));
  console.log(`  รายงานรายคอร์ส -> ${reportPath}  (เก็บไว้ในเครื่อง ไม่ commit - มีชื่อเล่นนักเรียน)`);

  if (!commit) {
    console.log("\n  DRY RUN - ยังไม่แก้. อ่านรายงาน โดยเฉพาะรายชื่อที่จะหมดอายุทันที แล้วรันซ้ำด้วย --commit");
    process.exit(0);
  }
  console.log("\n✓ แก้เรียบร้อย - แตะเฉพาะคอลัมน์ expiry_date. รันซ้ำได้ (ครั้งที่สองจะพบ 0 รายการ)");
  console.log("  อย่าลืมรันทั้ง sid และ uat");
  process.exit(0);
}

if (import.meta.main) await main();
