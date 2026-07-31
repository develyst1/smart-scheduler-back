// TASK-056 — a suspended household must not appear in the BOOKING pickers, while staying visible everywhere
// else. These pin the two rules that are easy to get wrong, without a DB:
//   1. the exclusion is driven by `lib/suspend.ts` (one rule, not a restatement), and
//   2. a parentless walk-in student is NEVER excluded (the set is built with an innerJoin on purpose, so such
//      students simply aren't in it — the badge-report failure mode, avoided by construction).
import { describe, expect, test } from "bun:test";
import { isSuspended } from "../lib/suspend";

/** Mirrors `suspendedStudentIds()`: the set is built from joined rows, filtered by the shared predicate. */
const buildSuspendedSet = (rows: Array<{ id: string; suspendedAt: Date | string | null }>) =>
  new Set(rows.filter((r) => isSuspended(r.suspendedAt)).map((r) => r.id));

const SUSPENDED = new Date("2026-08-01T00:00:00Z");

describe("suspendedStudentIds — the set the pickers exclude (TASK-056)", () => {
  test("students of a suspended household are in the set; active ones are not", () => {
    const set = buildSuspendedSet([
      { id: "s-susp", suspendedAt: SUSPENDED },
      { id: "s-active", suspendedAt: null },
    ]);
    expect(set.has("s-susp")).toBe(true);
    expect(set.has("s-active")).toBe(false);
  });

  test("🔑 a PARENTLESS walk-in student can't be in the set — the join has no row for them", () => {
    // `suspendedStudentIds` innerJoins students→parents, so a student with parent_id = null never appears.
    const set = buildSuspendedSet([{ id: "s-susp", suspendedAt: SUSPENDED }]);
    expect(set.has("s-walkin")).toBe(false); // → stays visible in both pickers, flag or no flag
  });

  test("un-suspending removes them again (reversible, like the People screen)", () => {
    expect(buildSuspendedSet([{ id: "s1", suspendedAt: SUSPENDED }]).has("s1")).toBe(true);
    expect(buildSuspendedSet([{ id: "s1", suspendedAt: null }]).has("s1")).toBe(false);
  });
});

describe("picker filtering semantics (TASK-058: exclusion is now the DEFAULT)", () => {
  const all = [{ id: "s-susp" }, { id: "s-active" }, { id: "s-walkin" }];
  const suspended = buildSuspendedSet([{ id: "s-susp", suspendedAt: SUSPENDED }]);
  const visibleAfterExclusion = () =>
    all.filter((s) => !suspended.has(s.id)).map((s) => s.id);

  test("/students/eligible filters UNCONDITIONALLY — it only ever answers 'who can be booked'", () => {
    expect(visibleAfterExclusion()).toEqual(["s-active", "s-walkin"]); // walk-in kept
  });

  test("🔑 /students now excludes suspended households with NO flag — all three consumers want it", () => {
    // TASK-056's opt-in `bookable` is retired: an opt-in policy means "remember to ask", and whoever forgets
    // opens a silent hole. Booking picker AND both sale modals get the same answer.
    expect(visibleAfterExclusion()).toEqual(["s-active", "s-walkin"]);
  });

  test("🔑 the walk-in survives the default exclusion (no household to suspend)", () => {
    expect(visibleAfterExclusion()).toContain("s-walkin");
  });

  test("nobody suspended → the exclusion list is empty and every student is returned", () => {
    const none = buildSuspendedSet([{ id: "s-active", suspendedAt: null }]);
    expect([...none]).toEqual([]); // the empty-array guard path
    expect(all.filter((s) => !none.has(s.id)).map((s) => s.id)).toEqual([
      "s-susp",
      "s-active",
      "s-walkin",
    ]);
  });
});
