// TASK-150 (SPEC-051 / REQ-055) — the importer's rules, on SYNTHETIC rows only.
// 🔴 Not one line here comes from the customer's file: these are invented names, invented phones, invented
// birthdays, chosen to hit each AC's edge. That is deliberate — the rules must be testable without putting a
// real child's data in git.
import { describe, expect, test } from "bun:test";
import {
  batchKey,
  batchSizes,
  checkBatchSize,
  buildReport,
  classifyRow,
  filterBatch,
  groupFamilies,
  looksLikeParentRow,
  normalizeImportPhone,
  parseCsv,
  parseImportDob,
  reconciles,
  splitNameAndNickname,
  toRawRows,
  type RawRow,
} from "./student-import";

const row = (over: Partial<RawRow> & { excelRow: number }): RawRow => ({
  day: "จันทร์",
  name: "น้องเอ",
  dob: "01/02/2018",
  nationality: "ไทย",
  gender: "ช",
  phone: "812345678", // 9 digits — Excel dropped the leading 0
  parentNote: "",
  ...over,
});

const NONE = new Set<number>();

describe("phone → 10 digits or hold back (AC-4/AC-9)", () => {
  test("the dropped leading zero is restored", () => {
    expect(normalizeImportPhone("812345678")).toEqual({ phone: "0812345678" });
  });

  test("a value that already carries its 0 is not double-prefixed", () => {
    expect(normalizeImportPhone("0812345678")).toEqual({ phone: "0812345678" });
  });

  test("separators are ignored, the digits are what count", () => {
    expect(normalizeImportPhone("81-234-5678").phone).toBe("0812345678");
  });

  test("too short / too long → held back with the reason, never stored", () => {
    expect(normalizeImportPhone("8123456").phone).toBeNull();
    expect(normalizeImportPhone("81234567890").phone).toBeNull();
    expect(normalizeImportPhone("8123456").reason).toContain("10 หลัก");
  });

  test("no phone at all → held back (a family we cannot contact)", () => {
    expect(normalizeImportPhone("")).toEqual({ phone: null, reason: "ไม่มีเบอร์โทร" });
  });
});

describe("DOB → parsed or EMPTY, never guessed (AC-10)", () => {
  test("DD/MM/YYYY becomes an ISO date", () => {
    expect(parseImportDob("01/02/2018").birthDate).toBe("2018-02-01");
    expect(parseImportDob("7/12/2019").birthDate).toBe("2019-12-07");
  });

  test("a separator-less blob is NOT interpreted", () => {
    for (const bad of ["3072021", "22022020"]) {
      const r = parseImportDob(bad);
      expect(r.birthDate).toBeNull();
      expect(r.reason).toContain("ไม่ชัดเจน");
    }
  });

  test("a year outside a child's range is refused rather than accepted", () => {
    expect(parseImportDob("01/02/1998").birthDate).toBeNull();
    expect(parseImportDob("01/02/2030").birthDate).toBeNull();
  });

  test("an impossible date (31/02) is refused, not rolled over into March", () => {
    expect(parseImportDob("31/02/2018").birthDate).toBeNull();
  });

  test("blank → empty + reported", () => {
    expect(parseImportDob("")).toEqual({ birthDate: null, reason: "ไม่มีวันเกิด" });
  });
});

describe("parent rows are never students (AC-11)", () => {
  test("obvious parent prefixes are recognised", () => {
    expect(looksLikeParentRow("คุณแม่น้องเอ")).toBe(true);
    expect(looksLikeParentRow("ผู้ปกครองน้องบี")).toBe(true);
  });

  test("an ordinary child name is not swept up by the rule", () => {
    expect(looksLikeParentRow("น้องเอ")).toBe(false);
    expect(looksLikeParentRow("ข้าวปั้น")).toBe(false);
  });

  test("a parent row is HELD, with the reason, and produces no person", () => {
    const c = classifyRow(row({ excelRow: 9, name: "คุณแม่น้องเอ" }), NONE);
    expect(c.state).toBe("hold");
    expect(c.person).toBeUndefined();
    expect(c.reasons.join()).toContain("ผู้ปกครอง");
  });
});

describe("name / nickname split", () => {
  test("`ชื่อ (ชื่อเล่น)` splits; a plain cell stays whole", () => {
    expect(splitNameAndNickname("สมชาย (เอ)")).toEqual({ name: "สมชาย", nickname: "เอ" });
    expect(splitNameAndNickname("น้องบี")).toEqual({ name: "น้องบี", nickname: null });
  });
});

describe("classifyRow — the three states (AC-13/AC-16)", () => {
  test("a clean row imports, with the note carrying column A verbatim (AC-12)", () => {
    const c = classifyRow(row({ excelRow: 5, day: "เสาร์" }), NONE);
    expect(c.state).toBe("import");
    expect(c.person?.phone).toBe("0812345678");
    expect(c.person?.note).toContain("เสาร์");
    expect(c.person?.note).toContain("แถว 5");
    expect(c.reasons).toEqual([]);
  });

  test("yellow wins over everything and is excluded entirely", () => {
    const c = classifyRow(row({ excelRow: 7 }), new Set([7]));
    expect(c.state).toBe("yellow");
    expect(c.person).toBeUndefined();
  });

  test("a bad DOB does NOT hold the child back — imported with an empty birthday + a reason", () => {
    const c = classifyRow(row({ excelRow: 8, dob: "3072021" }), NONE);
    expect(c.state).toBe("import");
    expect(c.person?.birthDate).toBeNull();
    expect(c.reasons.join()).toContain("วันเกิด");
  });

  test("a bad phone DOES hold the row back", () => {
    expect(classifyRow(row({ excelRow: 11, phone: "123" }), NONE).state).toBe("hold");
  });
});

describe("families — one parent per phone (AC-3)", () => {
  test("two children on one phone → ONE family with two children", () => {
    const fams = groupFamilies([
      classifyRow(row({ excelRow: 2, name: "น้องเอ" }), NONE),
      classifyRow(row({ excelRow: 3, name: "น้องบี" }), NONE),
    ]);
    expect(fams).toHaveLength(1);
    expect(fams[0]!.children).toHaveLength(2);
  });

  test("different phones stay different families", () => {
    const fams = groupFamilies([
      classifyRow(row({ excelRow: 2, phone: "811111111" }), NONE),
      classifyRow(row({ excelRow: 3, phone: "822222222" }), NONE),
    ]);
    expect(fams).toHaveLength(2);
  });

  test("the parent's name comes from column H", () => {
    const fams = groupFamilies([classifyRow(row({ excelRow: 2, parentNote: "คุณแม่สมศรี" }), NONE)]);
    expect(fams[0]!.parentName).toBe("คุณแม่สมศรี");
  });

  test("a held PARENT ROW still donates its name to the family sharing that phone (AC-11)", () => {
    const fams = groupFamilies([
      classifyRow(row({ excelRow: 2, name: "คุณแม่สมศรี" }), NONE), // held, not a student
      classifyRow(row({ excelRow: 3, name: "น้องเอ" }), NONE),
    ]);
    expect(fams).toHaveLength(1);
    expect(fams[0]!.parentName).toBe("คุณแม่สมศรี");
    expect(fams[0]!.children).toHaveLength(1); // the parent row is NOT one of them
  });
});

describe("report + reconciliation (AC-2/AC-15)", () => {
  const classified = [
    classifyRow(row({ excelRow: 4 }), NONE), // ✅
    classifyRow(row({ excelRow: 2, phone: "" }), NONE), // ⚠️
    classifyRow(row({ excelRow: 3 }), new Set([3])), // ⛔
  ];

  test("sorted top-down by source row, three marks, reason inline", () => {
    const { lines } = buildReport(classified);
    expect(lines.map((l) => l.excelRow)).toEqual([2, 3, 4]);
    expect(lines.map((l) => l.mark)).toEqual(["⚠️", "⛔", "✅"]);
    expect(lines[0]!.text).toContain("ไม่มีเบอร์โทร");
  });

  test("no row disappears: imported + held + yellow = total", () => {
    const { counts } = buildReport(classified);
    expect(counts).toEqual({ total: 3, imported: 1, held: 1, yellow: 1 });
    expect(reconciles(counts)).toBe(true);
  });
});

describe("CSV reading + day batches (AC-5/AC-14)", () => {
  const csv = [
    "วัน,ลำดับ,ชื่อ,วันเกิด,สัญชาติ,เพศ,เบอร์,ผู้ปกครอง",
    'จันทร์,1,"น้องเอ (เอ)",01/02/2018,ไทย,ช,812345678,คุณแม่สมศรี',
    "เสาร์,2,น้องบี,02/03/2019,ไทย,ญ,822222222,",
    ",,,,,,,",
    "Voucher,3,น้องซี,03/04/2020,ไทย,ช,833333333,",
  ].join("\n");

  test("Thai survives the round trip, quoted fields split correctly, the BOM is stripped", () => {
    const rows = toRawRows(parseCsv(`﻿${csv}`));
    expect(rows).toHaveLength(3); // the blank spacing line is not a person
    expect(rows[0]!.name).toBe("น้องเอ (เอ)");
    expect(rows[0]!.parentNote).toBe("คุณแม่สมศรี");
  });

  test("excelRow matches what the owner sees in the sheet (header counted)", () => {
    const rows = toRawRows(parseCsv(csv));
    expect(rows.map((r) => r.excelRow)).toEqual([2, 3, 5]);
  });

  test("a batch is a column-A day group, including Voucher", () => {
    const rows = toRawRows(parseCsv(csv));
    expect(filterBatch(rows, "จันทร์").map((r) => r.excelRow)).toEqual([2]);
    expect(filterBatch(rows, "voucher").map((r) => r.excelRow)).toEqual([5]);
    expect(filterBatch(rows)).toHaveLength(3);
    expect(batchKey(rows[0]!)).toBe("จันทร์");
  });

  test("a quoted comma inside a name does not split the row", () => {
    const cells = parseCsv('a,"b,c",d');
    expect(cells[0]).toEqual(["a", "b,c", "d"]);
  });
});

// ── TASK-150 REWORK (2026-08-19) ────────────────────────────────────────────────────────────────────────────
// The owner's dry run caught it: column A is a MERGED CELL per day group, so the CSV carries the day on the
// block's first row only. `--day Monday` matched 1 row of 9 — and reported a clean ✅. These are the two tests
// that make that impossible to ship again.
describe("merged day column is carried down (TASK-150 rework)", () => {
  const merged = [
    "day,no,name,dob,nat,gender,phone,parent",
    "Monday,1,A,01/02/2018,TH,M,811111111,",
    ",2,B,01/02/2018,TH,M,822222222,", // merged cell ⇒ empty in the export
    ",3,C,01/02/2018,TH,M,833333333,",
    "Tuesday,4,D,01/02/2018,TH,M,844444444,",
    ",5,E,01/02/2018,TH,M,855555555,",
  ].join("\n");

  test("rows 2–3 of a block inherit their block's day instead of being dayless", () => {
    const rows = toRawRows(parseCsv(merged));
    expect(rows.map((r) => r.day)).toEqual(["Monday", "Monday", "Monday", "Tuesday", "Tuesday"]);
  });

  test("the batch filter now selects the WHOLE day, not just its first row", () => {
    const rows = toRawRows(parseCsv(merged));
    expect(filterBatch(rows, "Monday")).toHaveLength(3);
    expect(filterBatch(rows, "Tuesday")).toHaveLength(2);
  });

  test("batchSizes reports each group as the file means it", () => {
    expect(batchSizes(toRawRows(parseCsv(merged)))).toEqual([
      { day: "Monday", rows: 3 },
      { day: "Tuesday", rows: 2 },
    ]);
  });
});

describe("per-batch self-check — an under-matched batch must be LOUD (TASK-150 rework)", () => {
  const rows = toRawRows(
    parseCsv(
      ["day,no,name,dob,nat,gender,phone,parent", "Mon,1,A,,TH,M,811111111,", ",2,B,,TH,M,822222222,"].join("\n"),
    ),
  );

  test("a complete batch passes", () => {
    expect(checkBatchSize(rows, "Mon", filterBatch(rows, "Mon")).ok).toBe(true);
  });

  test("selecting fewer rows than the file says the day has is a DEFECT, not a result", () => {
    const r = checkBatchSize(rows, "Mon", [rows[0]!]); // the exact old bug: 1 of 2
    expect(r.ok).toBe(false);
    expect(r.expected).toBe(2);
    expect(r.got).toBe(1);
    expect(r.message).toContain("2");
  });

  test("an unknown day name fails with a usable reason rather than importing nothing quietly", () => {
    const r = checkBatchSize(rows, "Sunday", []);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Sunday");
  });

  test("no --day means the whole file, and it still has to add up", () => {
    expect(checkBatchSize(rows, undefined, rows).ok).toBe(true);
    expect(checkBatchSize(rows, undefined, [rows[0]!]).ok).toBe(false);
  });
});
