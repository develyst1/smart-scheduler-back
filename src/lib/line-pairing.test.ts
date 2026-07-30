import { describe, expect, test } from "bun:test";
import { decideTeacherMatch, parentChildrenNote } from "./line-pairing";
import { t } from "./line-i18n";

describe("decideTeacherMatch — a nickname collision binds NOBODY (TASK-047)", () => {
  test("zero matches → none (unchanged behaviour)", () => {
    expect(decideTeacherMatch(0)).toBe("none");
  });
  test("exactly one match → one (links as before)", () => {
    expect(decideTeacherMatch(1)).toBe("one");
  });
  test("🔐 two+ teachers share the nickname → ambiguous, never 'first match wins'", () => {
    expect(decideTeacherMatch(2)).toBe("ambiguous");
    expect(decideTeacherMatch(5)).toBe("ambiguous");
  });
  test("the ambiguous reply exists in TH and EN and names no teacher but the typed nickname", () => {
    for (const lang of ["TH", "EN"] as const) {
      const msg = t("verify_teacher_ambiguous", lang, { nick: "off" });
      expect(msg).toContain("off");
      expect(msg).not.toBe("verify_teacher_ambiguous"); // key resolved, no raw-key leak
    }
  });
});

describe("parentChildrenNote — count, never names (TASK-047 PII leak)", () => {
  test("🔐 reports only a COUNT — a stranger who guesses a phone learns nothing identifying", () => {
    const th = parentChildrenNote(3, "TH");
    const en = parentChildrenNote(3, "EN");
    expect(th).toContain("3");
    expect(en).toContain("3");
    // the retired behaviour interpolated names — make sure nothing name-shaped can appear
    expect(th).not.toContain("{names}");
    expect(en).not.toContain("{names}");
  });

  test("no children → empty note (nothing to confirm)", () => {
    expect(parentChildrenNote(0, "TH")).toBe("");
    expect(parentChildrenNote(0, "EN")).toBe("");
  });

  test("the name-leaking i18n key is RETIRED — it must not resolve any more", () => {
    // `t()` returns the key itself for an unknown key, which is how we assert it's gone.
    expect(t("verify_parent_students", "TH")).toBe("verify_parent_students");
    expect(t("verify_parent_students", "EN")).toBe("verify_parent_students");
  });
});
