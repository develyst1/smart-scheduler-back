// SPEC-051 / TASK-150 (REQ-055 wave 1) — the PURE rules behind the go-live student/family importer.
//
// 🔴 This file must never contain a real row. Every rule here is an AC from SPEC-051, and the point of keeping
// them pure is that they can be tested with synthetic data instead of the customer's children.
//
// The importer's job is narrow on purpose: parents + students, nothing invented (AC-7). Anything the sheet
// cannot answer cleanly is HELD BACK with a reason rather than guessed — a wrong phone or a made-up birthday is
// worse than a row the owner fixes by hand.

/** One sheet row, already split into columns. `excelRow` is the source row number — every report line carries it. */
export interface RawRow {
  excelRow: number;
  day: string; // col A — preserved verbatim, interpreted by nobody (AC-12)
  name: string; // col C
  dob: string; // col D
  nationality: string; // col E
  gender: string; // col F
  phone: string; // col G — Excel dropped the leading 0
  parentNote: string; // col H — family / parent name
}

export type RowState = "import" | "hold" | "yellow";

export interface Classified {
  row: RawRow;
  state: RowState;
  /** Why it is held (or excluded). Empty for a clean importable row. */
  reasons: string[];
  /** Present only when state === "import". */
  person?: { name: string; nickname: string | null; birthDate: string | null; phone: string; note: string };
  /** A row that is plainly a parent is never created as a student (AC-11) — it is reported for a human. */
  isParentRow: boolean;
}

// ── Phone (AC-4 / AC-9) ────────────────────────────────────────────────────────────────────────────────────
// Excel dropped the leading 0, so the sheet holds 9 digits. Prefix it back; anything that is not exactly a
// 10-digit `0…` number is NOT stored — a family we cannot phone or pair on LINE is a hold-back, not a guess.
export function normalizeImportPhone(raw: string): { phone: string | null; reason?: string } {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return { phone: null, reason: "ไม่มีเบอร์โทร" };
  const candidate = digits.startsWith("0") ? digits : `0${digits}`;
  if (!/^0\d{9}$/.test(candidate)) {
    return { phone: null, reason: `เบอร์โทรไม่ครบ 10 หลัก (${candidate.length} หลัก)` };
  }
  return { phone: candidate };
}

// ── Date of birth (AC-10) ──────────────────────────────────────────────────────────────────────────────────
// `DD/MM/YYYY` only. A separator-less blob, a blank, or a year outside a child's range → EMPTY + reported.
// Never guessed: a birthday is not something to infer from a malformed cell.
const DOB_MIN_YEAR = 2005;
const DOB_MAX_YEAR = 2026;

export function parseImportDob(raw: string): { birthDate: string | null; reason?: string } {
  const v = (raw ?? "").trim();
  if (!v) return { birthDate: null, reason: "ไม่มีวันเกิด" };
  const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return { birthDate: null, reason: `วันเกิดไม่ชัดเจน (${v})` };
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (year < DOB_MIN_YEAR || year > DOB_MAX_YEAR) {
    return { birthDate: null, reason: `ปีเกิดไม่อยู่ในช่วง ${DOB_MIN_YEAR}–${DOB_MAX_YEAR} (${v})` };
  }
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== day || d.getUTCMonth() + 1 !== month) {
    return { birthDate: null, reason: `วันเกิดไม่ถูกต้อง (${v})` };
  }
  return { birthDate: iso };
}

// ── Parent rows (AC-11) ────────────────────────────────────────────────────────────────────────────────────
// Some rows are a parent, not a child. They must never become students. Conservative prefix match only —
// anything less obvious stays a student row and is the owner's to correct, because a broader guess here would
// silently drop real children.
const PARENT_PREFIXES = ["คุณแม่", "คุณพ่อ", "ผู้ปกครอง", "มารดา", "บิดา", "แม่น้อง", "พ่อน้อง"];

export const looksLikeParentRow = (name: string): boolean =>
  PARENT_PREFIXES.some((p) => (name ?? "").trim().startsWith(p));

/** `ชื่อ (ชื่อเล่น)` → name + nickname. No parenthetical ⇒ the whole cell is the name, nickname stays empty. */
export function splitNameAndNickname(raw: string): { name: string; nickname: string | null } {
  const v = (raw ?? "").trim();
  const m = v.match(/^(.*?)\s*[（(]([^）)]+)[）)]\s*$/);
  if (!m) return { name: v, nickname: null };
  const name = (m[1] ?? "").trim();
  const nickname = (m[2] ?? "").trim();
  return name ? { name, nickname } : { name: nickname, nickname: null };
}

// ── One row → its verdict ──────────────────────────────────────────────────────────────────────────────────
/** `yellowRows` is an EXPLICIT owner-supplied set of Excel row numbers (AC-13) — cell fill is never inferred. */
export function classifyRow(row: RawRow, yellowRows: ReadonlySet<number>): Classified {
  if (yellowRows.has(row.excelRow)) {
    return { row, state: "yellow", reasons: ["ยังไม่พร้อม (แถวสีเหลือง)"], isParentRow: false };
  }
  const isParentRow = looksLikeParentRow(row.name);
  const reasons: string[] = [];
  const { phone, reason: phoneReason } = normalizeImportPhone(row.phone);
  if (phoneReason) reasons.push(phoneReason);
  if (isParentRow) reasons.push("แถวนี้เป็นผู้ปกครอง ไม่ใช่นักเรียน — ไม่สร้างเป็นนักเรียน");
  const hasName = !!(row.name ?? "").trim();
  if (!hasName) reasons.push("ไม่มีชื่อ");

  if (!phone || isParentRow || !hasName) return { row, state: "hold", reasons, isParentRow };

  // A malformed DOB does NOT hold the row back — the child is imported with an empty birthday and the row is
  // still reported, so the owner can fill it in later (AC-10).
  const { birthDate, reason: dobReason } = parseImportDob(row.dob);
  if (dobReason) reasons.push(dobReason);
  const { name, nickname } = splitNameAndNickname(row.name);
  return {
    row,
    state: "import",
    reasons,
    isParentRow: false,
    person: { name, nickname, birthDate, phone, note: buildNote(row) },
  };
}

/** Column A verbatim + the parent note — kept as free text, driving nothing (AC-12). */
export function buildNote(row: RawRow): string {
  const parts = [`แถว ${row.excelRow}`];
  if ((row.day ?? "").trim()) parts.push(`วันเรียน(จากไฟล์): ${row.day.trim()}`);
  if ((row.parentNote ?? "").trim()) parts.push(`ผู้ปกครอง(จากไฟล์): ${row.parentNote.trim()}`);
  return parts.join(" · ");
}

// ── Families (AC-3) ────────────────────────────────────────────────────────────────────────────────────────
export interface Family {
  phone: string;
  /** Column H, or a parent-row's own name, whichever the sheet gave us. `null` ⇒ leave the parent unnamed. */
  parentName: string | null;
  children: Classified[];
}

/** One parent per phone; children sharing a phone merge into that one family — never two parents (AC-3).
 *  A HELD parent-row still donates its name to the phone it shares, which is the whole point of AC-11. */
export function groupFamilies(classified: Classified[]): Family[] {
  const byPhone = new Map<string, Family>();
  const nameFromParentRow = new Map<string, string>();

  for (const c of classified) {
    if (c.state === "yellow" || !c.isParentRow) continue;
    const { phone } = normalizeImportPhone(c.row.phone);
    if (phone && (c.row.name ?? "").trim()) nameFromParentRow.set(phone, c.row.name.trim());
  }

  for (const c of classified) {
    if (c.state !== "import" || !c.person) continue;
    const phone = c.person.phone;
    const sheetName = (c.row.parentNote ?? "").trim() || nameFromParentRow.get(phone) || null;
    if (!byPhone.has(phone)) byPhone.set(phone, { phone, parentName: sheetName, children: [] });
    const fam = byPhone.get(phone)!;
    if (!fam.parentName) fam.parentName = sheetName;
    fam.children.push(c);
  }
  return [...byPhone.values()];
}

// ── Report (AC-2 / AC-15) ──────────────────────────────────────────────────────────────────────────────────
export interface ReportLine {
  excelRow: number;
  state: RowState;
  mark: "✅" | "⚠️" | "⛔";
  text: string;
}

export interface ReportCounts {
  total: number;
  imported: number;
  held: number;
  yellow: number;
}

/** A work checklist for the owner: one line per source row, sorted top-down, three states, reason inline. */
export function buildReport(classified: Classified[]): { lines: ReportLine[]; counts: ReportCounts } {
  const lines = [...classified]
    .sort((a, b) => a.row.excelRow - b.row.excelRow)
    .map((c): ReportLine => {
      const mark = c.state === "import" ? "✅" : c.state === "yellow" ? "⛔" : "⚠️";
      const label = c.state === "import" ? "ทำได้" : c.state === "yellow" ? "ยังไม่พร้อม" : "ติด";
      const why = c.reasons.length ? ` — ${c.reasons.join(" · ")}` : "";
      return { excelRow: c.row.excelRow, state: c.state, mark, text: `${mark} แถว ${c.row.excelRow} ${label}${why}` };
    });
  return {
    lines,
    counts: {
      total: classified.length,
      imported: classified.filter((c) => c.state === "import").length,
      held: classified.filter((c) => c.state === "hold").length,
      yellow: classified.filter((c) => c.state === "yellow").length,
    },
  };
}

/** AC-2's invariant: nothing may disappear between the sheet and the report. */
export const reconciles = (c: ReportCounts): boolean => c.imported + c.held + c.yellow === c.total;

// ── CSV input ──────────────────────────────────────────────────────────────────────────────────────────────
// Deliberately dependency-free: the owner exports the sheet as **CSV UTF-8** and the importer parses that. See
// the task notes — adding an xlsx library to a go-live path is a bigger decision than it looks, and the yellow
// set already has to arrive as an explicit input either way (AC-13).

/** RFC-4180-ish split: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, ""); // Excel writes a BOM on "CSV UTF-8"
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Sheet rows → `RawRow`s. `headerRows` are skipped but still counted, so `excelRow` matches what the owner sees.
 *
 *  🔴 **Column A is a MERGED CELL per day group** (TASK-150 rework, caught by the owner's dry run): the CSV
 *  export carries `Monday` on the first row of the block and leaves rows 2..n of that block EMPTY. Filtering on
 *  the literal cell therefore matched 1 row of 9 — and reported success. A merged cell *means* "this value
 *  applies to every row it spans", so the value is carried down, which is what the sheet says on screen. */
export function toRawRows(cells: string[][], headerRows = 1): RawRow[] {
  const out: RawRow[] = [];
  let lastDay = "";
  for (let i = headerRows; i < cells.length; i++) {
    const r = cells[i] ?? [];
    const at = (n: number) => (r[n] ?? "").trim();
    // A wholly empty line is spacing in the sheet, not a person — skipped without a report line. It does NOT
    // reset the carried day: a blank spacer inside a block doesn't end the merge.
    if (!r.some((c) => (c ?? "").trim())) continue;
    if (at(0)) lastDay = at(0);
    out.push({
      excelRow: i + 1, // 1-based, matching Excel's own row numbers
      day: lastDay,
      name: at(2),
      dob: at(3),
      nationality: at(4),
      gender: at(5),
      phone: at(6),
      parentNote: at(7),
    });
  }
  return out;
}

/** A batch = one column-A day group (incl. `Voucher`), so the owner can do "Monday only, then stop" (AC-14). */
export const batchKey = (row: RawRow): string => (row.day ?? "").trim() || "(ไม่ระบุวัน)";

export const filterBatch = (rows: RawRow[], day?: string): RawRow[] =>
  !day ? rows : rows.filter((r) => batchKey(r).toLowerCase() === day.trim().toLowerCase());

/** Every day group in the file with its row count — the file's own answer to "how big is this batch?". */
export function batchSizes(rows: RawRow[]): Array<{ day: string; rows: number }> {
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(batchKey(r), (byDay.get(batchKey(r)) ?? 0) + 1);
  return [...byDay].map(([day, n]) => ({ day, rows: n }));
}

/**
 * TASK-150 rework — the batch self-check the merged-cell defect earned.
 *
 * The old failure was not a crash: `--day Monday` matched 1 row of 9 and reported a clean, self-consistent
 * ✅ — one child imported, a green report, and nobody the wiser until the customer noticed. Counting the
 * batch against the FILE (not against itself) is what makes that loud: the file knows the day has 9 rows, so a
 * batch of 1 is a defect, not a result.
 */
export function checkBatchSize(
  allRows: RawRow[],
  day: string | undefined,
  selected: RawRow[],
): { ok: boolean; expected: number; got: number; message?: string } {
  const expected = day
    ? (batchSizes(allRows).find((b) => b.day.toLowerCase() === day.trim().toLowerCase())?.rows ?? 0)
    : allRows.length;
  const got = selected.length;
  if (expected === 0) {
    return { ok: false, expected, got, message: `ไม่พบกลุ่มวัน "${day}" ในไฟล์ — ตรวจชื่อวันหรือ --header-rows` };
  }
  if (got !== expected) {
    return {
      ok: false,
      expected,
      got,
      message: `จำนวนแถวของ batch ไม่ตรงกับไฟล์: คาดว่า ${expected} แถว แต่เลือกได้ ${got} แถว — หยุดไว้ก่อน`,
    };
  }
  return { ok: true, expected, got };
}
