// TASK-157 (SPEC-057 / REQ-060 Part B.1) — the repair decision, on synthetic rows.
// Two things must hold absolutely: a row that is ALREADY correct is never rewritten (the hand-fixed row), and an
// unreadable value is left alone rather than blanked.
import { describe, expect, test } from "bun:test";
import {
  formatRepairCounts,
  formatRepairReport,
  planDemographicsRepair,
  planRepair,
  repairValues,
  type StudentDemographics,
} from "./demographics-repair";

const s = (over: Partial<StudentDemographics> = {}): StudentDemographics => ({
  id: "s-1",
  name: "น้องทดสอบ",
  gender: "Male",
  nationality: "Thai",
  ...over,
});

describe("what gets repaired (AC-4)", () => {
  test("`Male` / `Thai` are the whole point — both fixed in one row", () => {
    const r = planDemographicsRepair(s());
    expect(r.changes).toEqual([
      { field: "gender", from: "Male", to: "male" },
      { field: "nationality", from: "Thai", to: "ไทย" },
    ]);
    expect(repairValues(r)).toEqual({ gender: "male", nationality: "ไทย" });
  });

  test("only the field that is wrong is touched", () => {
    expect(planDemographicsRepair(s({ nationality: "ไทย" })).changes.map((c) => c.field)).toEqual(["gender"]);
  });
});

describe("🔑 what is NEVER touched (AC-5 / AC-6)", () => {
  test("a row already normalised is skipped — no special case for the hand-fixed one", () => {
    const r = planDemographicsRepair(s({ name: "คุณมะเหมี่ยว", gender: "female", nationality: "ไทย" }));
    expect(r.changes).toEqual([]);
    expect(repairValues(r)).toEqual({}); // nothing would be written for this row at all
  });

  test("a foreign nationality is left as written — `Japan` is not a casing error", () => {
    expect(planDemographicsRepair(s({ gender: "male", nationality: "Japan" })).changes).toEqual([]);
  });

  test("an UNREADABLE stored value is left in place and reported — the repair never erases", () => {
    const r = planDemographicsRepair(s({ gender: "?", nationality: "ไทย" }));
    expect(r.changes).toEqual([]);
    expect(r.unreadable).toEqual([{ field: "gender", value: "?" }]);
  });

  test("empty stays empty — a blank is not something to invent a value for", () => {
    const r = planDemographicsRepair(s({ gender: null, nationality: null }));
    expect(r.changes).toEqual([]);
    expect(r.unreadable).toEqual([]);
  });

  test("a repair can only ever produce gender/nationality keys — nothing else is writable", () => {
    for (const row of [s(), s({ gender: "F" }), s({ nationality: "TH" })]) {
      expect(Object.keys(repairValues(planDemographicsRepair(row))).every((k) => k === "gender" || k === "nationality")).toBe(true);
    }
  });
});

describe("the whole set + idempotency", () => {
  const set = [
    s({ id: "1", gender: "Male", nationality: "Thai" }),
    s({ id: "2", gender: "Female", nationality: "Thai" }),
    s({ id: "3", name: "คุณมะเหมี่ยว", gender: "female", nationality: "ไทย" }), // already correct
    s({ id: "4", gender: "?", nationality: "Japan" }), // unreadable gender, foreign nationality
  ];

  test("counts split the set honestly", () => {
    const p = planRepair(set);
    expect(p.counts).toEqual({ total: 4, gender: 2, nationality: 2, unreadable: 1, alreadyCorrect: 2 });
    expect(p.toWrite).toHaveLength(2);
  });

  test("🔑 a second run finds NOTHING — the repair is idempotent", () => {
    const after = planRepair(set).rows.map((r, i) => {
      const orig = set[i]!;
      const v = repairValues(r);
      return { ...orig, gender: v.gender ?? orig.gender, nationality: v.nationality ?? orig.nationality };
    });
    expect(planRepair(after).toWrite).toHaveLength(0);
  });

  test("the console line is counts only — no name can appear in it", () => {
    const line = formatRepairCounts(planRepair(set));
    expect(line).not.toContain("คุณมะเหมี่ยว");
    expect(line).not.toContain("น้องทดสอบ");
    expect(line).toContain("แก้เพศ 2");
  });

  test("the FILE report names rows (that is why it is gitignored) and flags the unreadable one", () => {
    const lines = formatRepairReport(planRepair(set));
    expect(lines.some((l) => l.includes("gender: Male → male"))).toBe(true);
    expect(lines.some((l) => l.includes("อ่านไม่ออก"))).toBe(true);
    expect(lines.some((l) => l.includes("คุณมะเหมี่ยว"))).toBe(false); // an unchanged row isn't noise in the report
  });
});
