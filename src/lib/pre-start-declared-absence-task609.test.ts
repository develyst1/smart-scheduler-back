// TASK-609 (REQ-111 F) — a course that has NOT STARTED takes a planned absence FREE, capped at the quota the customer bought.
//
// 🔑 This JOINS two things that already existed and writes no third rule:
//   · "has it started" — `courseNotStarted` (TASK-570's derived predicate), asked from the leave door, never re-written;
//   · the free-absence SHAPE — `plannedAtCreation` + `leaveCharged: false`, with the make-up still appended (the at-creation path).
// 🔴 And the rule the owner cared about: a declared day and a charged leave must NEVER be editable into one another — including
//    across a START-DATE CHANGE, which MOVES sessions across the "has it started" boundary.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { courseLeaveQuota } from "./leave";
import { courseNotStarted, isStartChangeRefusal, planCourseStartChange, type StartChangeRow } from "./course-start-change";

const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const S = code("src/services/scheduler.service.ts");
const region = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from) + from.length));
const TODAY = "2026-10-01";
const C = { startDate: "2026-10-05", size: 4, expiryDate: "2026-11-02", priorSessions: 0 };
const R = (id: string, date: string, status = "PENDING", extra: Partial<StartChangeRow> = {}): StartChangeRow =>
  ({ id, date, status, teacherId: "t1", extendedFromId: null, bookingType: "COURSE_PACKAGE", ...extra });

describe("🔑 TASK-609 — the two halves are REUSED, not re-written", () => {
  test("the leave door asks TASK-570's predicate — there is no second 'has it started' rule in the service", () => {
    expect(S).toContain("if (!courseNotStarted(current.course, rows as any, bangkokNow().date)) return null;");
    // 🚫 one definition: the service never derives "started" for itself
    expect(S).not.toMatch(/priorSessions.*>.*0|every\(\(r\) => .*date >= today\)/);
    expect((S.match(/courseNotStarted\(/g) ?? []).length).toBe(1);
  });
  test("🔑 the CAP comes from the COURSE, never a constant: its own `leave_quota` wins, else the by-size table", () => {
    expect(S).toContain("return { declared, quota: courseLeaveQuota(current.course) };");
    // by value — the same course SIZE, two different quotas, because one course bought a different number
    expect(courseLeaveQuota({ size: 4 })).toBe(courseLeaveQuota({ size: 4, leaveQuota: null }));
    expect(courseLeaveQuota({ size: 4, leaveQuota: 7 })).toBe(7);
    expect(courseLeaveQuota({ size: 4, leaveQuota: 0 })).toBe(0); // bought none ⇒ declares none
  });
  test("the boundary itself is TASK-570's, unchanged — a session TODAY still counts as not started; anything delivered does not", () => {
    expect(courseNotStarted(C, [R("b1", TODAY), R("b2", "2026-10-08")], TODAY)).toBe(true);
    expect(courseNotStarted(C, [R("b0", "2026-09-28", "ATTENDED"), R("b1", TODAY)], TODAY)).toBe(false);
    expect(courseNotStarted({ ...C, priorSessions: 2 }, [R("b1", TODAY)], TODAY)).toBe(false);
  });
});

describe("🔴 TASK-609 — FREE, capped, and refused in words an admin can act on", () => {
  const LEAVE = region(S, "const pre = await preStartDeclaration(tx, current);", "for (const sid of duoStudentIds(current))");
  test("a pre-start absence is born in the AT-CREATION shape: `plannedAtCreation` + no charge", () => {
    expect(LEAVE).toContain("const declaredFree = !!pre;");
    expect(LEAVE).toContain("leaveCharged: charges, ...(declaredFree ? { plannedAtCreation: true } : {})");
    expect(LEAVE).toContain("const charges = !declaredFree && !!(");
  });
  test("…and it still gets its MAKE-UP, and is never 'locked' — its gate is the declared cap, not `leaveRemaining`", () => {
    expect(LEAVE).toContain("if (canTakeLeave(current.course) || declaredFree) {");
    const gate = region(LEAVE, "if (canTakeLeave(current.course) || declaredFree) {", "locked = true;");
    expect(gate).toContain('status: "EXTENDED"'); // the make-up is appended inside the same branch
  });
  test("🔑 AT THE CAP the act is refused with the COUNT, before anything is written", () => {
    expect(LEAVE).toContain("if (pre && pre.declared >= pre.quota) {");
    expect(LEAVE).toContain('throw conflict("DECLARED_ABSENCE_CAP"');
    expect(LEAVE).toContain("${pre.declared}/${pre.quota}"); // the numbers an admin needs, in the sentence
    // …and it is thrown BEFORE the row write
    expect(LEAVE.indexOf('conflict("DECLARED_ABSENCE_CAP"')).toBeLessThan(LEAVE.indexOf('.set({ status: "SICK_LEAVE"'));
  });
  test("⚖️ SAME NUMBER, SEPARATE COUNTER — answered from the code: `leaveUsed` moves only where a charge is recorded", () => {
    // every increment of the bought pool is guarded by `charges`, and `charges` excludes a declared day ⇒ a declaration
    // cannot spend the post-start allowance. The cap counts DECLARED DAYS against the quota's NUMBER instead.
    const increments = [...S.matchAll(/leaveUsed: sql`\$\{coursePackages\.leaveUsed\} \+ 1`/g)];
    expect(increments).toHaveLength(2);
    for (const m of increments) {
      const before = S.slice(Math.max(0, m.index! - 400), m.index!);
      expect({ at: m.index, guarded: /if \(charges\) \{/.test(before) || /!b\.plannedAtCreation/.test(before) }).toEqual({ at: m.index, guarded: true });
    }
    expect(S).toContain("const declared = (rows as any[]).filter((r) => r.id !== current.id && r.plannedAtCreation).length;");
  });
});

describe("⚖️ TASK-609 §3 — the cap counts DECLARATIONS MADE, so it cannot be reset (@Sober's leak, ruled)", () => {
  test("by source: the count is by `plannedAtCreation` ALONE — a declared day that is later CANCELLED still counts", () => {
    // 🔑 Counting only live `SICK_LEAVE` rows would let cancel-and-re-declare reset the cap without limit, and **a limit any later
    // edit can reset is decorative** — the owner's own objection to a quota that does not hold.
    expect(S).toContain("const declared = (rows as any[]).filter((r) => r.id !== current.id && r.plannedAtCreation).length;");
    expect(S).not.toMatch(/r.status === "SICK_LEAVE" && r.plannedAtCreation/); // the status filter is GONE from the cap
  });
  test("⚠️ and the COST is pinned, not left to be discovered: neither a cancel nor the Undo clears the flag", () => {
    // ⇒ a declaration taken back still consumes one of the cap. 🚫 Deliberately NOT fixed by clearing `plannedAtCreation` on the
    // Undo: that flag is what `leaveChargeOf` reads to answer "was this leave free?" — clearing it would change what the Undo
    // reports about a row it has already refunded. **If the owner wants corrections free, that is his call and a separate line.**
    const U = code("src/services/undo.service.ts");
    expect(U).not.toMatch(/plannedAtCreation/); // the Undo neither reads nor clears it
    expect(code("src/lib/booking-undo.ts")).toContain("if (row.plannedAtCreation) return \"free\";"); // …it is the FREE answer, which is why
  });
});
describe("🔴 TASK-609 — NO CONVERSION, both ways, and ACROSS A START-DATE CHANGE (the dangerous one)", () => {
  test("a declared day can never become charged: the only charge path excludes `plannedAtCreation`, on BOTH leave doors", () => {
    expect(S).toContain("const charges = !declaredFree && !!(current.courseId && current.course && canTakeLeave(current.course) && !current.plannedAtCreation);");
    expect(S).toContain('leaveCharged: !b.plannedAtCreation'); // the plan-editor door, unchanged
  });
  test("a charged leave can never become free: nothing clears `leaveCharged` or sets `plannedAtCreation` outside creation and the pre-start declaration", () => {
    const sets = [...S.matchAll(/plannedAtCreation: true/g)].length;
    expect(sets).toBe(3); // the creation insert · the creation flip · 🔻 TASK-609's declaration — and nothing else
    // `leaveCharged: false` is written in exactly ONE place — the creation flip, where a free day is BORN beside
    // `plannedAtCreation: true`. 🔑 The claim is that it never appears ALONE, which is what "clearing a charge" would look like.
    const falses = [...S.matchAll(/.*leaveCharged: false.*/g)].map((m) => m[0]);
    expect(falses).toHaveLength(1);
    expect(falses[0]).toContain("plannedAtCreation: true");
    expect(falses[0]).toContain('.set({ status: "SICK_LEAVE"');
  });
  test("🔴 a START-DATE CHANGE moves sessions across the boundary and converts NOTHING — by value, through the planner", async () => {
    // a declared day (free) and a charged leave on the same not-yet-started course
    const rows = [
      R("b1", "2026-10-05"),
      R("free", "2026-10-12", "SICK_LEAVE", { plannedAtCreation: true }),
      R("paid", "2026-10-19", "SICK_LEAVE"), // a charged leave — no `plannedAtCreation`
      R("b4", "2026-10-26"),
    ];
    const p = await planCourseStartChange({ ...C, expiryDate: "2026-11-09" }, rows, "2026-10-12", TODAY, async () => false);
    if (isStartChangeRefusal(p)) throw new Error(p.message);
    // every row MOVES…
    expect(p.moves.map((m) => [m.id, m.to])).toEqual([["b1", "2026-10-12"], ["free", "2026-10-19"], ["paid", "2026-10-26"], ["b4", "2026-11-02"]]);
    // …and each keeps its OWN status: a leave stays a leave, and neither becomes the other
    expect(p.moves.filter((m) => m.toStatus === "SICK_LEAVE").map((m) => m.id)).toEqual(["free", "paid"]);
    // 🔑 the planner carries NO charge fields at all — so it cannot flip one into the other even by accident
    const PLAN = code("src/lib/course-start-change.ts");
    const apply = region(code("src/services/scheduler.service.ts"), "async function planStartChange(", "export async function resumeCourse(");
    expect(apply).toContain("await tx.update(bookings).set({ date: m.to, ...reconfirm }).where(eq(bookings.id, m.id));");
    // 🔑 the claim is about the WRITE, not the read: the wiring must READ `plannedAtCreation` (the expiry stretch depends on it),
    // so the assertion is that no `.set({…})` in the apply mentions either field — the row write carries date + reconfirm only.
    const sets = [...apply.matchAll(/\.set\(\{[^}]*\}\)/g)].map((m) => m[0]);
    expect(sets.length).toBeGreaterThan(0);
    expect(sets.filter((x) => /plannedAtCreation|leaveCharged/.test(x))).toEqual([]);
    expect(apply).toContain("plannedAtCreation: r.plannedAtCreation"); // …and it is READ, deliberately
    expect(PLAN).not.toMatch(/leaveCharged/);
  });
  test("…and the planner still READS a declared day (it stretches the expiry), which is why its absence above is a claim and not an oversight", () => {
    expect(code("src/lib/course-start-change.ts")).toContain('const declared = plan.filter((r) => r.status === "SICK_LEAVE" && r.plannedAtCreation).length;');
  });
});
