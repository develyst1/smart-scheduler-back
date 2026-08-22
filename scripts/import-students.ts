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
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { students } from "../src/db/schema";
import { formatChange, planStudentUpdate, updateValues } from "../src/lib/student-update-plan";
import { createStudentForParent, findOrCreateParentByPhone, listStudentsOfParent } from "../src/services/parent.service";
import {
  buildReport,
  batchSizes,
  checkBatchSize,
  classifyRow,
  normalizeImportPhone,
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
const DRY_RUN_ROLLBACK = "__dry_run_rollback__";

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

  // TASK-156 (AC-2): the dry run must show what a commit would CHANGE, so it now READS the database (read-only,
  // inside a rolled-back transaction) to diff each row against what is stored. Reading is not writing — the
  // sentinel rollback below guarantees a dry run still cannot write, exactly as before.
  const extraLines: string[] = [];
  let createdParents = 0;
  let createdStudents = 0;
  let existingStudents = 0;
  let updatedStudents = 0;
  let reviewRenames = 0;
  try {
    await db.transaction(async (tx: any) => {
      for (const fam of families) {
        const before = await tx.query.parents.findFirst({ where: (p: any, { eq: e }: any) => e(p.phone, fam.phone) });
        const parent = commit
          ? await findOrCreateParentByPhone(fam.phone, { name: fam.parentName }, tx)
          : before ?? null;
        if (!before) createdParents++;
        const existing = parent ? await listStudentsOfParent(parent.id, tx) : [];
        for (const child of fam.children) {
          const p = child.person!;
          const rowNo = child.row.excelRow;
          const others = normalizeImportPhone(child.row.phone).others ?? [];
          if (others.length) extraLines.push(`   แถว ${rowNo} · เบอร์สำรอง: ${others.join(" , ")}`); // +AC-8 echo
          const resolution = planStudentUpdate({
            sheet: { name: p.name, birthDate: p.birthDate, gender: p.gender, nationality: p.nationality },
            storedChildren: existing.map((s: any) => ({
              id: s.id,
              name: s.name,
              birthDate: s.birthDate ?? null,
              gender: s.gender ?? null,
              nationality: s.nationality ?? null,
            })),
            parentIsNew: !before,
          });

          if (resolution.kind === "unchanged") {
            existingStudents++;
            extraLines.push(`   แถว ${rowNo} · ไม่เปลี่ยนแปลง`);
            continue;
          }
          if (resolution.kind === "review-rename") {
            // 🔴 The whole point of REQ-059: a name-miss under a KNOWN parent is a rename-or-new-sibling
            // question. Never auto-created (that is the 31 duplicates), never auto-updated.
            reviewRenames++;
            const names = resolution.candidates.map((c) => `${c.name}${c.birthDate ? ` (${c.birthDate})` : ""}`);
            extraLines.push(
              `   ⚠️ แถว ${rowNo} · review: possible rename — ชื่อในไฟล์ "${p.name}"` +
                `${p.birthDate ? ` (${p.birthDate})` : ""} · เด็กที่มีอยู่ของผู้ปกครองนี้: ${names.join(" / ") || "(ไม่มี)"}`,
            );
            continue;
          }
          if (resolution.kind === "update") {
            updatedStudents++;
            const diff = resolution.changes.map(formatChange).join(" · ");
            const kept = resolution.kept.length ? ` · คงค่าเดิม (ไฟล์ว่าง): ${resolution.kept.join(", ")}` : "";
            extraLines.push(`   แถว ${rowNo} · อัปเดต — ${diff}${kept}`);
            if (commit) {
              await tx.update(students).set(updateValues(resolution.changes)).where(eq(students.id, resolution.target.id));
            }
            continue;
          }
          createdStudents++;
          extraLines.push(`   แถว ${rowNo} · สร้างใหม่`);
          if (commit && parent) {
            await createStudentForParent(
              parent.id,
              {
                name: p.name,
                nickname: p.nickname,
                note: p.note,
                // TASK-154: normalised on write — `Male`→`male`, `Thai`→`ไทย` — so every existing reader works.
                gender: p.gender,
                birthDate: p.birthDate,
                nationality: p.nationality,
              },
              tx,
            );
          }
        }
      }
      if (!commit) throw new Error(DRY_RUN_ROLLBACK);
    });
  } catch (e: any) {
    if (e?.message !== DRY_RUN_ROLLBACK) {
      console.error(`✗ import:students ไม่สำเร็จ — ไม่มีการเปลี่ยนแปลง (rollback): ${e?.message ?? e}`);
      process.exit(1);
    }
  }

  const outcome =
    `   สร้างใหม่ ${createdStudents} · อัปเดต ${updatedStudents} · ไม่เปลี่ยน ${existingStudents} · ` +
    `รอตรวจสอบ(อาจเปลี่ยนชื่อ) ${reviewRenames} · ผู้ปกครองใหม่ ${createdParents}`;
  console.log(outcome);
  for (const l of extraLines) console.log(l);

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
  let updatedStudents = 0;
  let reviewRenames = 0;
  await db.transaction(async (tx) => {
    for (const fam of families) {
      const before = await tx.query.parents.findFirst({ where: (p: any, { eq }: any) => eq(p.phone, fam.phone) });
      const parent = await findOrCreateParentByPhone(fam.phone, { name: fam.parentName }, tx);
      if (!before) createdParents++;
      const existing = await listStudentsOfParent(parent.id, tx);
      for (const child of fam.children) {
        const p = child.person!;
        // TASK-156 (REQ-059): the sheet is edited between runs, so a re-import must UPDATE, not skip — and a
        // name that no longer matches is a rename-or-new-sibling question, never a silent second child.
        const resolution = planStudentUpdate({
          sheet: { name: p.name, birthDate: p.birthDate, gender: p.gender, nationality: p.nationality },
          storedChildren: existing.map((s: any) => ({
            id: s.id,
            name: s.name,
            birthDate: s.birthDate ?? null,
            gender: s.gender ?? null,
            nationality: s.nationality ?? null,
          })),
          parentIsNew: !before,
        });
        if (resolution.kind === "unchanged") {
          existingStudents++;
          continue;
        }
        if (resolution.kind === "review-rename") {
          reviewRenames++; // held: a human decides. Nothing is written for this row.
          continue;
        }
        if (resolution.kind === "update") {
          await tx.update(students).set(updateValues(resolution.changes)).where(eq(students.id, resolution.target.id));
          updatedStudents++;
          continue;
        }
        await createStudentForParent(
          parent.id,
          {
            name: p.name,
            nickname: p.nickname,
            note: p.note,
            // TASK-154: normalised on write — `Male`→`male`, `Thai`→`ไทย` — so every existing reader works.
            gender: p.gender,
            birthDate: p.birthDate,
            nationality: p.nationality,
          },
          tx,
        );
        createdStudents++;
      }
    }
  });

  console.log(
    `✓ นำเข้าแล้ว: ผู้ปกครองใหม่ ${createdParents} · นักเรียนใหม่ ${createdStudents} · อัปเดต ${updatedStudents} · ไม่เปลี่ยน ${existingStudents} · รอตรวจสอบ(อาจเปลี่ยนชื่อ) ${reviewRenames}`,
  );
  console.log("   รันซ้ำ batch เดิมได้ — จะไม่สร้างซ้ำ (idempotent)");
  process.exit(0);
}

if (import.meta.main) await main();
