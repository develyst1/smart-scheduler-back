// SPEC-056 / TASK-156 (REQ-059) — re-importing an EDITED sheet safely.
//
// Wave 1 was insert-only: match → skip, else create. That was right for an empty box and is wrong now. The
// customer keeps editing the sheet, and 31 of those edits are **renames** — under the old `(phone, name)` match
// every one of them would have quietly become a **second child**, next to a first child that already has courses
// attached. This module is the resolution that prevents that.
//
// The rule that matters most: a name that doesn't match under a known parent is **not** a decision the tool is
// allowed to make. `เอแคลร์` → `เอแคลร์ อังศุมาลิณณ์` and a genuine new sibling look identical in the data, so both
// become ONE review line naming the candidate child. 31 silent duplicate-forks become 31 questions a human
// answers in seconds.
import { normalizeGender, normalizeNationality } from "./demographics";

export interface SheetChild {
  name: string;
  birthDate: string | null;
  gender: string | null;
  nationality: string | null;
}

export interface StoredChild {
  id: string;
  name: string;
  birthDate: string | null;
  gender: string | null;
  nationality: string | null;
}

export type Resolution =
  | { kind: "create" }
  | { kind: "update"; target: StoredChild; changes: FieldChange[]; kept: string[] }
  | { kind: "unchanged"; target: StoredChild }
  | { kind: "review-rename"; candidates: StoredChild[] };

export interface FieldChange {
  field: "birthDate" | "gender" | "nationality";
  from: string | null;
  to: string | null;
}

/** Import-owned fields ONLY. Courses, bookings, vouchers, quota, plans, LINE links and notes are never read or
 *  written by an update — the sheet is not the source of truth for anything a human did inside the product. */
const IMPORT_OWNED = ["birthDate", "gender", "nationality"] as const;

const norm = (c: { gender: string | null; nationality: string | null; birthDate: string | null }) => ({
  birthDate: c.birthDate?.trim() || null,
  // Normalise BOTH sides before comparing, or `Male` vs `male` reads as a correction every single run.
  gender: normalizeGender(c.gender ?? "").value,
  nationality: normalizeNationality(c.nationality ?? "").value,
});

/**
 * What one sheet row should do to one family's stored children.
 * `storedChildren` is every child already under the matched parent (empty when the parent is new).
 */
export function planStudentUpdate(input: {
  sheet: SheetChild;
  storedChildren: readonly StoredChild[];
  /** True when THIS run created the parent — then a child can only be new (AC-1). */
  parentIsNew: boolean;
}): Resolution {
  const sheetName = (input.sheet.name ?? "").trim();
  if (input.parentIsNew) return { kind: "create" };

  const match = input.storedChildren.find((s) => (s.name ?? "").trim() === sheetName);
  if (!match) {
    // A known parent whose children don't include this name: a rename or a new sibling. Indistinguishable from
    // the data, so it is a question, never an action.
    return { kind: "review-rename", candidates: [...input.storedChildren] };
  }

  const s = norm(input.sheet);
  const t = norm(match);
  const changes: FieldChange[] = [];
  const kept: string[] = [];

  for (const field of IMPORT_OWNED) {
    const from = t[field];
    const to = s[field];
    if (to === null) {
      // The sheet is blank. A blank cell is not an instruction to erase what the product already knows —
      // somebody may have filled it in by hand (the `คุณมะเหมี่ยว` case).
      if (from !== null) kept.push(field);
      continue;
    }
    if (from !== to) changes.push({ field, from, to });
  }

  return changes.length ? { kind: "update", target: match, changes, kept } : { kind: "unchanged", target: match };
}

/** `field: from → to`, so the dry run shows exactly what a commit would overwrite (AC-2). */
export const formatChange = (c: FieldChange): string => `${c.field}: ${c.from ?? "(ว่าง)"} → ${c.to ?? "(ว่าง)"}`;

/** The values a commit would write, normalised — the script hands this straight to the update. */
export const updateValues = (changes: readonly FieldChange[]): Record<string, string | null> =>
  Object.fromEntries(changes.map((c) => [c.field, c.to]));

// ── Dual phone (+AC-8) ──────────────────────────────────────────────────────────────────────────────────────
// Some cells hold two numbers (`x , y`). The FIRST valid one is the family key; the rest are echoed in the
// report so the information isn't lost, and the row imports — having a second contact is not a defect.
export function splitPhones(raw: string): { primary: string; others: string[] } {
  const parts = (raw ?? "")
    .split(/[,/]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return { primary: parts[0] ?? "", others: parts.slice(1) };
}
