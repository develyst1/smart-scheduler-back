// TASK-156 (SPEC-056 / REQ-059) — re-importing an edited sheet. Synthetic rows only.
// The case that matters most is `review-rename`: 31 real renames would otherwise have become 31 duplicate
// children sitting next to children that already have courses attached.
import { describe, expect, test } from "bun:test";
import { formatChange, planStudentUpdate, splitPhones, updateValues, type StoredChild } from "./student-update-plan";

const stored = (over: Partial<StoredChild> = {}): StoredChild => ({
  id: "s-1",
  name: "เอแคลร์",
  birthDate: "2018-02-01",
  gender: "male",
  nationality: "ไทย",
  ...over,
});
const sheet = (over: Partial<Parameters<typeof planStudentUpdate>[0]["sheet"]> = {}) => ({
  name: "เอแคลร์",
  birthDate: "2018-02-01",
  gender: "male",
  nationality: "ไทย",
  ...over,
});

describe("case 1 — a brand-new family (AC-1)", () => {
  test("a parent created by this run can only produce new children", () => {
    expect(planStudentUpdate({ sheet: sheet(), storedChildren: [], parentIsNew: true }).kind).toBe("create");
  });
});

describe("case 2 — update in place", () => {
  test("nothing differs → unchanged (AC-6: an immediate re-run writes nothing)", () => {
    const r = planStudentUpdate({ sheet: sheet(), storedChildren: [stored()], parentIsNew: false });
    expect(r.kind).toBe("unchanged");
  });

  test("`Male` vs stored `male` is NOT a diff — both sides are normalised first", () => {
    const r = planStudentUpdate({ sheet: sheet({ gender: "Male", nationality: "Thai" }), storedChildren: [stored()], parentIsNew: false });
    expect(r.kind).toBe("unchanged");
  });

  test("fill-empty: stored blank, sheet has a value → a change", () => {
    const r = planStudentUpdate({ sheet: sheet(), storedChildren: [stored({ birthDate: null })], parentIsNew: false });
    expect(r.kind).toBe("update");
    if (r.kind !== "update") return;
    expect(r.changes).toEqual([{ field: "birthDate", from: null, to: "2018-02-01" }]);
  });

  test("correction: both present and different → a change, shown as from → to (AC-2)", () => {
    const r = planStudentUpdate({ sheet: sheet({ gender: "Female" }), storedChildren: [stored()], parentIsNew: false });
    if (r.kind !== "update") throw new Error("expected update");
    expect(r.changes).toEqual([{ field: "gender", from: "male", to: "female" }]);
    expect(formatChange(r.changes[0]!)).toBe("gender: male → female");
    expect(updateValues(r.changes)).toEqual({ gender: "female" });
  });

  test("🔑 AC-3: a BLANK sheet cell never blanks a stored value — it is kept and reported", () => {
    const r = planStudentUpdate({
      sheet: sheet({ gender: "", nationality: "", birthDate: null }),
      storedChildren: [stored()],
      parentIsNew: false,
    });
    expect(r.kind).toBe("unchanged"); // nothing to write…
    const r2 = planStudentUpdate({
      sheet: sheet({ gender: "", birthDate: "2019-03-03" }),
      storedChildren: [stored()],
      parentIsNew: false,
    });
    if (r2.kind !== "update") throw new Error("expected update");
    expect(r2.changes.map((c) => c.field)).toEqual(["birthDate"]); // …and the blank field is not among the changes
    expect(r2.kept).toContain("gender"); // a human's in-product value survives the sheet's silence
  });

  test("AC-4: only import-owned fields can ever appear in a change", () => {
    const r = planStudentUpdate({
      sheet: sheet({ gender: "Female", nationality: "Japan", birthDate: "2019-01-01" }),
      storedChildren: [stored()],
      parentIsNew: false,
    });
    if (r.kind !== "update") throw new Error("expected update");
    expect(r.changes.map((c) => c.field).sort()).toEqual(["birthDate", "gender", "nationality"]);
    // nothing course/booking/voucher/quota/LINE/note-shaped can be produced by this function at all
    expect(Object.keys(updateValues(r.changes))).toHaveLength(3);
  });
});

describe("case 3 — 🔴 the rename question (AC-5 / +AC-9)", () => {
  test("a name-miss under a KNOWN parent is HELD for review, never created", () => {
    const r = planStudentUpdate({
      sheet: sheet({ name: "เอแคลร์ อังศุมาลิณณ์" }), // the real rename shape
      storedChildren: [stored({ name: "เอแคลร์" })],
      parentIsNew: false,
    });
    expect(r.kind).toBe("review-rename");
    if (r.kind !== "review-rename") return;
    expect(r.candidates.map((c) => c.name)).toEqual(["เอแคลร์"]); // the report names who it might be
  });

  test("a genuine new sibling is ALSO held — the data cannot tell them apart, so a human decides", () => {
    const r = planStudentUpdate({ sheet: sheet({ name: "น้องใหม่" }), storedChildren: [stored()], parentIsNew: false });
    expect(r.kind).toBe("review-rename");
  });

  test("an existing parent with NO children yet still holds rather than guessing", () => {
    expect(planStudentUpdate({ sheet: sheet(), storedChildren: [], parentIsNew: false }).kind).toBe("review-rename");
  });

  test("the right child is matched when a parent has several", () => {
    const r = planStudentUpdate({
      sheet: sheet({ name: "น้องบี", gender: "Female" }),
      storedChildren: [stored(), stored({ id: "s-2", name: "น้องบี", gender: null })],
      parentIsNew: false,
    });
    if (r.kind !== "update") throw new Error("expected update");
    expect(r.target.id).toBe("s-2");
  });
});

describe("dual phone (+AC-8)", () => {
  test("two numbers → the first is the key, the rest are echoed, the row is NOT held", () => {
    expect(splitPhones("812345678 , 899999999")).toEqual({ primary: "812345678", others: ["899999999"] });
    expect(splitPhones("812345678/899999999").others).toEqual(["899999999"]);
  });

  test("one number behaves exactly as before", () => {
    expect(splitPhones("812345678")).toEqual({ primary: "812345678", others: [] });
    expect(splitPhones("")).toEqual({ primary: "", others: [] });
  });
});
