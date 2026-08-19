// SPEC-051 / TASK-150 (REQ-055 wave 1) — the go-live parent+student importer. OWNER-RUN, never by the team.
//
// 🔴 Real children's data. The input file and the report live ONLY in gitignored `project-docs/`. Nothing here
// prints a name, phone or birthday to stdout — the on-screen output is row numbers and counts, so a pasted
// screenshot cannot leak a family. The full report goes to a file the owner keeps.
//
// Usage (from smart-scheduler-back, with the env pointing at the target DB):
//   bun run import:students --file "../project-docs/Student list.csv"                  # DRY RUN (default)
//   bun run import:students --file "…" --day "จันทร์"                                   # one batch only
//   bun run import:students --file "…" --yellow "12,15,88"        (or --yellow-file …)  # the not-ready rows
//   bun run import:students --file "…" --day "จันทร์" --commit                          # actually write
//
// Dry-run is the DEFAULT (the project's OBS-3 idiom): it reads, classifies, prints the counts and writes the
// report — and touches the database not at all. `--commit` is the only thing that writes, and it is idempotent:
// a parent is keyed on its phone, a student on (parent, name), so re-running a finished batch creates nothing.
import { db } from "../src/db";
import { createStudentForParent, findOrCreateParentByPhone, listStudentsOfParent } from "../src/services/parent.service";
import {
  buildReport,
  batchSizes,
  checkBatchSize,
  classifyRow,
  filterBatch,
  groupFamilies,
  parseCsv,
  reconciles,
  toRawRows,
  type Classified,
} from "../src/lib/student-import";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function readYellowRows(): Promise<Set<number>> {
  const inline = arg("yellow");
  const file = arg("yellow-file");
  const raw = file ? await Bun.file(file).text() : (inline ?? "");
  const nums = raw
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return new Set(nums);
}

async function main() {
  const file = arg("file");
  if (!file) {
    console.error("✗ import:students — pass --file <path to the CSV export of Student list.xlsx>");
    console.error('  e.g. bun run import:students --file "../project-docs/Student list.csv"');
    process.exit(1);
  }
  if (!(await Bun.file(file).exists())) {
    console.error(`✗ import:students — file not found: ${file}`);
    process.exit(1);
  }

  const commit = has("commit");
  const day = arg("day");
  const yellowRows = await readYellowRows();

  const cells = parseCsv(await Bun.file(file).text());
  const allRows = toRawRows(cells, Number(arg("header-rows") ?? 1));
  const rows = filterBatch(allRows, day);
  // TASK-150 rework: the batch is counted against the FILE, not against itself. A day the sheet says has 9 rows
  // must select 9 — the old defect selected 1 and reported a clean ✅, which is the failure worth preventing.
  const batch = checkBatchSize(allRows, day, rows);
  if (!batch.ok) {
    console.error(`🔴 ${batch.message}`);
    console.error("   กลุ่มวันในไฟล์: " + batchSizes(allRows).map((b) => `${b.day}=${b.rows}`).join(" · "));
    process.exit(1);
  }

  const classified: Classified[] = rows.map((r) => classifyRow(r, yellowRows));
  const { lines, counts } = buildReport(classified);
  const families = groupFamilies(classified);

  console.log(`── ${commit ? "COMMIT" : "DRY RUN"} · batch: ${day ?? "(ทั้งไฟล์)"} · ไฟล์: ${file}`);
  console.log(`   batch นี้ควรมี ${batch.expected} แถว · ได้ ${batch.got} ✔
   แถวทั้งหมด ${counts.total} · ทำได้ ${counts.imported} · ติด ${counts.held} · ยังไม่พร้อม ${counts.yellow}`);
  console.log(`   ครอบครัว (เบอร์ไม่ซ้ำ) ${families.length}`);
  if (!reconciles(counts)) {
    // AC-2: if this ever fails, a row went missing between the sheet and the report — stop, don't write.
    console.error("🔴 ยอดไม่ตรง: imported + held + yellow ≠ total — หยุดไว้ก่อน ไม่มีการเขียนข้อมูล");
    process.exit(1);
  }

  const stamp = arg("stamp") ?? "latest";
  const reportPath = arg("report") ?? `../project-docs/import-report-${day ?? "all"}-${stamp}.txt`;
  await Bun.write(
    reportPath,
    [
      `รายงานการนำเข้า (${commit ? "หลังนำเข้าจริง" : "ตรวจก่อนนำเข้า"}) · batch ${day ?? "(ทั้งไฟล์)"}`,
      `แถวทั้งหมด ${counts.total} · ทำได้ ${counts.imported} · ติด ${counts.held} · ยังไม่พร้อม ${counts.yellow}`,
      "",
      ...lines.map((l) => l.text),
    ].join("\n"),
  );
  console.log(`   รายงานรายแถว → ${reportPath}  (เก็บไว้ในเครื่อง ไม่ commit)`);

  if (!commit) {
    console.log("   DRY RUN — ไม่มีการเขียนฐานข้อมูล. ตรวจรายงานแล้วรันซ้ำด้วย --commit");
    process.exit(0);
  }

  let createdParents = 0;
  let createdStudents = 0;
  let existingStudents = 0;
  await db.transaction(async (tx) => {
    for (const fam of families) {
      const before = await tx.query.parents.findFirst({ where: (p: any, { eq }: any) => eq(p.phone, fam.phone) });
      const parent = await findOrCreateParentByPhone(fam.phone, { name: fam.parentName }, tx);
      if (!before) createdParents++;
      const existing = await listStudentsOfParent(parent.id, tx);
      for (const child of fam.children) {
        const p = child.person!;
        // Idempotency (AC-6): same family, same child name ⇒ nothing happens on a re-run.
        if (existing.some((s: any) => (s.name ?? "").trim() === p.name)) {
          existingStudents++;
          continue;
        }
        await createStudentForParent(
          parent.id,
          {
            name: p.name,
            nickname: p.nickname,
            note: p.note,
            gender: child.row.gender || null,
            birthDate: p.birthDate,
            nationality: child.row.nationality || null,
          },
          tx,
        );
        createdStudents++;
      }
    }
  });

  console.log(`✓ นำเข้าแล้ว: ผู้ปกครองใหม่ ${createdParents} · นักเรียนใหม่ ${createdStudents} · มีอยู่แล้ว ${existingStudents}`);
  console.log("   รันซ้ำ batch เดิมได้ — จะไม่สร้างซ้ำ (idempotent)");
  process.exit(0);
}

if (import.meta.main) await main();
