// TASK-154 (SPEC-054 / REQ-060 Part A) — the write-side normaliser. Synthetic values only; the shapes here are
// the ones the customer's sheet actually contains (`Male`/`Female`/blank · `Thai`/`Foreign`/`Japan`/`Taiwan`)
// plus the edges that decide whether a child is imported quietly wrong.
import { describe, expect, test } from "bun:test";
import { normalizeGender, normalizeNationality } from "./demographics";

describe("normalizeGender (AC-1/AC-3)", () => {
  test("the sheet's own spellings map to what the product reads", () => {
    expect(normalizeGender("Male").value).toBe("male");
    expect(normalizeGender("Female").value).toBe("female");
  });

  test("case and padding don't matter", () => {
    expect(normalizeGender("  MALE ").value).toBe("male");
    expect(normalizeGender("female").value).toBe("female");
  });

  test("the short and Thai forms staff type by hand", () => {
    expect(normalizeGender("M").value).toBe("male");
    expect(normalizeGender("ช").value).toBe("male");
    expect(normalizeGender("ชาย").value).toBe("male");
    expect(normalizeGender("F").value).toBe("female");
    expect(normalizeGender("ญ").value).toBe("female");
    expect(normalizeGender("หญิง").value).toBe("female");
    expect(normalizeGender("อื่นๆ").value).toBe("other");
  });

  test("🔑 EMPTY is a legitimate 'not recorded' — null, and NOT reported", () => {
    for (const blank of ["", "   "]) {
      expect(normalizeGender(blank)).toEqual({ value: null, unreadable: null });
    }
  });

  test("🔑 a NON-EMPTY unreadable value → null + reported, carrying the original text", () => {
    expect(normalizeGender("?")).toEqual({ value: null, unreadable: "?" });
    expect(normalizeGender("ไม่ระบุ").unreadable).toBe("ไม่ระบุ");
  });
});

describe("normalizeNationality (AC-2)", () => {
  test("every Thai spelling folds to the one value the product keys on", () => {
    for (const thai of ["Thai", "thai", "TH", "ไทย", "  Thai  "]) {
      expect(normalizeNationality(thai).value).toBe("ไทย");
    }
  });

  test("a real country passes through VERBATIM — we don't own a list of nationalities", () => {
    expect(normalizeNationality("Japan").value).toBe("Japan");
    expect(normalizeNationality("Taiwan").value).toBe("Taiwan");
  });

  test("a literal 'Foreign' is stored as written — honest to the source, not invented into a country", () => {
    expect(normalizeNationality("Foreign")).toEqual({ value: "Foreign", unreadable: null });
  });

  test("nationality is never 'unreadable' — only empty or a value", () => {
    expect(normalizeNationality("")).toEqual({ value: null, unreadable: null });
    expect(normalizeNationality("qwerty").unreadable).toBeNull();
  });
});
