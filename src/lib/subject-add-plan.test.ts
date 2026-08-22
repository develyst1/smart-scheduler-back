// TASK-153 (SPEC-053 / REQ-058) — what `subjects:add` decides before it writes. The nine real program names are
// the customer's, so the fixtures here are deliberately generic: what is being tested is the RULE, not the list.
import { describe, expect, test } from "bun:test";
import { formatSubjectAddPlan, isPriceGroup, planSubjectAdd } from "./subject-add-plan";

const teachers = [
  { id: "t-1", nickname: "ก้อง" },
  { id: "t-2", nickname: "แนน" },
  { id: "t-3", nickname: "แนน" }, // a deliberate nickname collision
];
const existing = ["Bike / Scooter / Balance Cruiser", "Surfskate"];

describe("creating vs leaving alone (AC-5)", () => {
  test("a new name is created", () => {
    const p = planSubjectAdd({ name: "Bike", group: "bike-skate", existingNames: existing });
    expect(p.ok).toBe(true);
    expect(p.willCreate).toBe(true);
    expect(p.alreadyPresent).toBe(false);
  });

  test("an existing name is a NO-OP, not an update and not an error (idempotent re-run)", () => {
    const p = planSubjectAdd({ name: "Surfskate", group: "bike-skate", existingNames: existing });
    expect(p.ok).toBe(true);
    expect(p.willCreate).toBe(false);
    expect(p.alreadyPresent).toBe(true);
  });

  test("the KEPT combined program cannot be touched — it just reports already-present", () => {
    const p = planSubjectAdd({
      name: "Bike / Scooter / Balance Cruiser",
      group: "bike-skate",
      existingNames: existing,
    });
    expect(p.willCreate).toBe(false);
    expect(p.alreadyPresent).toBe(true);
  });

  test("surrounding whitespace doesn't create a near-duplicate program", () => {
    expect(planSubjectAdd({ name: "  Surfskate  ", group: "bike-skate", existingNames: existing }).alreadyPresent).toBe(true);
  });
});

describe("price group is validated before any write (AC-4)", () => {
  test("the four real groups are accepted", () => {
    for (const g of ["bike-skate", "onewheel", "balance-private", "balance-group"]) {
      expect(isPriceGroup(g)).toBe(true);
      expect(planSubjectAdd({ name: "X", group: g, existingNames: [] }).ok).toBe(true);
    }
  });

  test("a typo'd group is REFUSED — an unsellable program must not be created", () => {
    const p = planSubjectAdd({ name: "X", group: "bike_skate", existingNames: [] });
    expect(p.ok).toBe(false);
    expect(p.willCreate).toBe(false);
    expect(p.problems.join()).toContain("bike-skate");
  });

  test("a missing name is refused too", () => {
    expect(planSubjectAdd({ name: "   ", group: "bike-skate", existingNames: [] }).ok).toBe(false);
  });
});

describe("optional teacher link (AC-3)", () => {
  test("a unique nickname resolves", () => {
    const p = planSubjectAdd({ name: "X", group: "bike-skate", existingNames: [], teacherQuery: "ก้อง", teachers });
    expect(p.ok).toBe(true);
    expect(p.link).toEqual({ id: "t-1", nickname: "ก้อง" });
  });

  test("an id resolves, and beats the nickname lookup", () => {
    expect(planSubjectAdd({ name: "X", group: "bike-skate", existingNames: [], teacherQuery: "t-2", teachers }).link?.id).toBe("t-2");
  });

  test("an AMBIGUOUS nickname is refused, never resolved by picking the first", () => {
    const p = planSubjectAdd({ name: "X", group: "bike-skate", existingNames: [], teacherQuery: "แนน", teachers });
    expect(p.ok).toBe(false);
    expect(p.link).toBeNull();
    expect(p.problems.join()).toContain("มากกว่า 1");
  });

  test("an unknown teacher is refused before any write — no partial create", () => {
    const p = planSubjectAdd({ name: "X", group: "bike-skate", existingNames: [], teacherQuery: "ไม่มีคนนี้", teachers });
    expect(p.ok).toBe(false);
    expect(p.willCreate).toBe(false);
  });

  test("no --teacher means no link, and that is a valid run", () => {
    const p = planSubjectAdd({ name: "X", group: "bike-skate", existingNames: [] });
    expect(p.ok).toBe(true);
    expect(p.link).toBeNull();
  });
});

describe("operator output", () => {
  test("prints the action and the group, and surfaces every problem", () => {
    const out = formatSubjectAddPlan(planSubjectAdd({ name: "X", group: "nope", existingNames: [] }));
    expect(out).toContain("จะสร้างใหม่");
    expect(out).toContain("🔴");
  });

  test("an already-present program says so in words, not just a flag", () => {
    expect(formatSubjectAddPlan(planSubjectAdd({ name: "Surfskate", group: "bike-skate", existingNames: existing }))).toContain(
      "มีอยู่แล้ว",
    );
  });
});
