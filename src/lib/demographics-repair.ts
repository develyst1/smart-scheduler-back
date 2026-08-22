// SPEC-057 / TASK-157 (REQ-060 Part B.1) — the PURE decision for repairing rows written BEFORE Part A.
//
// Part A fixed the importer; these are the rows it was too late for — 24 on `uat`, ~130 on `sid`, still holding
// `Male` / `Thai`, so the product shows them with no gender and marks Thai children foreign. This decides, per
// row, whether a value is merely mis-cased (repair) or genuinely unreadable (leave it alone and say so).
//
// The rule that keeps a human's work safe: a value that already normalises **to itself** is skipped. That is why
// `คุณมะเหมี่ยว` — the one row staff fixed by hand — needs **no special case**; `female` normalises to `female`,
// so there is simply nothing to change. A repair that has to remember an exception is a repair waiting to break it.
import { normalizeGender, normalizeNationality } from "./demographics";

export interface StudentDemographics {
  id: string;
  name: string;
  gender: string | null;
  nationality: string | null;
}

export interface RepairChange {
  field: "gender" | "nationality";
  from: string;
  to: string;
}

export interface RepairRow {
  id: string;
  name: string;
  changes: RepairChange[];
  /** Non-empty values we could not read. Left exactly as they are — the repair fixes casing, never erases. */
  unreadable: Array<{ field: "gender" | "nationality"; value: string }>;
}

/** One student → what (if anything) the repair would write. `changes` empty ⇒ the row is already correct. */
export function planDemographicsRepair(s: StudentDemographics): RepairRow {
  const changes: RepairChange[] = [];
  const unreadable: RepairRow["unreadable"] = [];

  const g = normalizeGender(s.gender ?? "");
  if (s.gender && g.value === null) unreadable.push({ field: "gender", value: s.gender });
  else if (s.gender && g.value !== null && g.value !== s.gender) {
    changes.push({ field: "gender", from: s.gender, to: g.value });
  }

  const n = normalizeNationality(s.nationality ?? "");
  // Nationality never returns `unreadable` — an unrecognised value passes through as itself, so it simply
  // equals the stored value and produces no change (`Japan` stays `Japan`).
  if (s.nationality && n.value !== null && n.value !== s.nationality) {
    changes.push({ field: "nationality", from: s.nationality, to: n.value });
  }

  return { id: s.id, name: s.name, changes, unreadable };
}

export interface RepairPlan {
  rows: RepairRow[];
  toWrite: RepairRow[];
  counts: { total: number; gender: number; nationality: number; unreadable: number; alreadyCorrect: number };
}

export function planRepair(students: readonly StudentDemographics[]): RepairPlan {
  const rows = students.map(planDemographicsRepair);
  const toWrite = rows.filter((r) => r.changes.length > 0);
  return {
    rows,
    toWrite,
    counts: {
      total: students.length,
      gender: toWrite.filter((r) => r.changes.some((c) => c.field === "gender")).length,
      nationality: toWrite.filter((r) => r.changes.some((c) => c.field === "nationality")).length,
      unreadable: rows.filter((r) => r.unreadable.length > 0).length,
      alreadyCorrect: rows.filter((r) => r.changes.length === 0).length,
    },
  };
}

/** The columns a repair writes — `gender` / `nationality` and nothing else, ever. */
export const repairValues = (r: RepairRow): Record<string, string> =>
  Object.fromEntries(r.changes.map((c) => [c.field, c.to]));

/** 🔴 COUNTS ONLY — this is what may go to the console. Names live in the gitignored report file. */
export const formatRepairCounts = (p: RepairPlan): string =>
  `  นักเรียนทั้งหมด ${p.counts.total} · แก้เพศ ${p.counts.gender} · แก้สัญชาติ ${p.counts.nationality} · ` +
  `อ่านไม่ออก(ไม่แตะ) ${p.counts.unreadable} · ปกติอยู่แล้ว ${p.counts.alreadyCorrect}`;

/** The named per-row lines — for the gitignored `project-docs/` report, never the console. */
export function formatRepairReport(p: RepairPlan): string[] {
  const lines: string[] = [];
  for (const r of p.rows) {
    if (r.changes.length) {
      lines.push(`✏️ ${r.name} — ${r.changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join(" · ")}`);
    }
    for (const u of r.unreadable) lines.push(`⚠️ ${r.name} — ${u.field} อ่านไม่ออก (${u.value}) — ไม่แก้ไข`);
  }
  return lines;
}
