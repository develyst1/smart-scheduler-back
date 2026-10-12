// TASK-800 (REQ-118) — THE BACKFILL'S DECISIONS, pure (the script `scripts/backfill-area-codes.ts` only reads the rows and writes the plan).
//
// What it may infer, and what it never does:
//   · PROVINCE CODE — from `parents.province` by EXACT Thai name, and only when that name is one of our 77. A value that is not one of the 77 is LISTED (`province-not-one-of-77`) and NEVER parsed.
//   · DISTRICT + SUB-DISTRICT — ONLY from a `note` line that is EXACTLY the format our own doors wrote (`addressLine`: three parts, space-separated: «{sub-district} {district} {province|กทม}», the province matching
//     `parents.province`) AND whose three Thai names resolve to EXACTLY ONE code triple in the dataset.
//   · Everything else stays NULL and is LISTED with a reason — parent id + reason, NEVER any personal text. 🚫 No guessing, no fuzzy matching, no "closest district".
// Idempotent: a parent that already holds codes is skipped (`already-has-codes`), so a re-run changes nothing. The note is never changed; `province` is never changed.
import { THAI_PROVINCES } from "./thai-provinces";
import { loadGeography, provinceCodeByThaiName, triplesByThaiNames, type Geography } from "./area-codes";

export type BackfillRow = { id: string; province: string | null; note: string | null; provinceCode: string | null; districtCode: string | null; subdistrictCode: string | null };
export type UnmatchedReason = "province-not-one-of-77" | "no-province" | "no-address-line" | "line-not-our-format" | "name-not-in-dataset" | "ambiguous";
export type BackfillDecision =
  | { id: string; action: "skip"; reason: "already-has-codes" }
  | { id: string; action: "write"; provinceCode: string; districtCode: string | null; subdistrictCode: string | null; level: "province" | "full"; unmatched: UnmatchedReason | null }
  | { id: string; action: "none"; unmatched: UnmatchedReason };

const SEVENTY_SEVEN = new Set(THAI_PROVINCES);
const BANGKOK = "กรุงเทพมหานคร";
const EVERYDAY: Record<string, string> = { [BANGKOK]: "กทม" }; // `addressLine`'s short form of the province on the ONE line
const LOOKS_LIKE_AN_ADDRESS = /(ตำบล|แขวง|อำเภอ|เขต|จังหวัด)/;

/** The note lines of our own doors' format for THIS province: exactly three space-separated parts, the last the province (or its everyday short form). */
function ourFormatLines(note: string, province: string): string[][] {
  const tail = new Set([province, EVERYDAY[province]].filter(Boolean) as string[]);
  const out: string[][] = [];
  for (const line of note.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 3 && parts.every(Boolean) && tail.has(parts[2]!)) out.push(parts);
  }
  return out;
}
/** Does ANY line mention the province (or look like an address)? — separates «no address line at all» from «an address-ish line that is not ours». */
function mentionsAnAddress(note: string, province: string): boolean {
  const tail = [province, EVERYDAY[province]].filter(Boolean) as string[];
  return note.split(/\r?\n/).some((l) => tail.some((t) => l.includes(t)) || LOOKS_LIKE_AN_ADDRESS.test(l));
}

export function decide(row: BackfillRow, g: Geography): BackfillDecision {
  if (row.provinceCode || row.districtCode || row.subdistrictCode) return { id: row.id, action: "skip", reason: "already-has-codes" };
  const province = row.province?.trim() || "";
  if (!province) return { id: row.id, action: "none", unmatched: "no-province" };
  if (!SEVENTY_SEVEN.has(province)) return { id: row.id, action: "none", unmatched: "province-not-one-of-77" }; // never parsed
  const provinceCode = provinceCodeByThaiName(province, g);
  if (!provinceCode) return { id: row.id, action: "none", unmatched: "name-not-in-dataset" }; // one of OUR 77 but absent from the dataset: the gate should have caught it — listed, not guessed
  const base = { id: row.id, action: "write" as const, provinceCode };
  const note = row.note ?? "";
  const lines = ourFormatLines(note, province);
  if (!lines.length) {
    const why: UnmatchedReason = !note.trim() ? "no-address-line" : mentionsAnAddress(note, province) ? "line-not-our-format" : "no-address-line";
    return { ...base, districtCode: null, subdistrictCode: null, level: "province", unmatched: why };
  }
  const triples = new Map<string, ReturnType<typeof triplesByThaiNames>[number]>();
  let anyResolved = false;
  for (const [sub, district] of lines.map((p) => [p[0]!, p[1]!] as const)) {
    const found = triplesByThaiNames(province, district, sub, g);
    if (found.length) anyResolved = true;
    for (const t of found) triples.set(`${t.provinceCode}|${t.districtCode}|${t.subdistrictCode}`, t);
  }
  if (!anyResolved) return { ...base, districtCode: null, subdistrictCode: null, level: "province", unmatched: "name-not-in-dataset" };
  if (triples.size !== 1) return { ...base, districtCode: null, subdistrictCode: null, level: "province", unmatched: "ambiguous" }; // two lines that disagree, or a name that names two places
  const t = [...triples.values()][0]!;
  return { ...base, districtCode: t.districtCode, subdistrictCode: t.subdistrictCode, level: "full", unmatched: null };
}

export type BackfillPlan = {
  decisions: BackfillDecision[];
  counts: { parents: number; skippedAlreadyHaveCodes: number; provinceCodes: number; fullTriples: number; unmatched: Record<UnmatchedReason, number> };
  unmatched: Array<{ id: string; reason: UnmatchedReason }>;
};
export function planBackfill(rows: BackfillRow[], g: Geography = loadGeography()): BackfillPlan {
  const decisions = rows.map((r) => decide(r, g));
  const unmatchedCount: Record<UnmatchedReason, number> = { "province-not-one-of-77": 0, "no-province": 0, "no-address-line": 0, "line-not-our-format": 0, "name-not-in-dataset": 0, ambiguous: 0 };
  const unmatched: Array<{ id: string; reason: UnmatchedReason }> = [];
  let skipped = 0, provinceCodes = 0, full = 0;
  for (const d of decisions) {
    if (d.action === "skip") { skipped++; continue; }
    if (d.action === "write") { provinceCodes++; if (d.level === "full") full++; }
    const reason = d.action === "write" ? d.unmatched : d.unmatched;
    if (reason) { unmatchedCount[reason]++; unmatched.push({ id: d.id, reason }); }
  }
  return { decisions, counts: { parents: rows.length, skippedAlreadyHaveCodes: skipped, provinceCodes, fullTriples: full, unmatched: unmatchedCount }, unmatched };
}
