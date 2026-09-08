// TASK-299 — the extension ceiling was RE-DERIVED from the purchase date, so the stored `expiryDate` — the
// column `course-plan.ts` itself calls *"only the MAX_WEEK ceiling"* — was never consulted.
//
// 🔑 ONE line, THREE faces: the owner's `Create plan` disabled at week 5 with three declared absences · a
// resumed course refusing a make-up because `startDate` correctly stays the PURCHASE date · and an admin moving
// the expiry so an extra session fits, **and nothing happening at all.**
//
// ⚠️ **The first describe is written first on purpose** (@Sober): the risk in this change is not that it fails,
// it is that it quietly makes the ceiling unreachable. `EXPIRY_REQUIRED` was a gate for a code that could never
// arrive and we deleted it this week — this must not become the next one.
import { describe, expect, test } from "bun:test";
import { courseBornCeiling, exceedsExtensionCeiling } from "./course-plan";
import { addDays } from "./time";
import { courseExpiry } from "./recurring";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSrc } from "./read-src";

/** Comments stripped: a doc block that names the expression it replaced would defeat the negative assertions. */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const START = "2026-09-01"; // a Tuesday
const week = (n: number) => addDays(START, (n - 1) * 7); // week 1 IS the start week (TASK-197)

describe("🔑 TASK-299 — the ceiling still REFUSES automatic growth. Written first.", () => {
  // A leave marked AFTER creation drives an auto-extend. It has no deliberate act behind it, so the agreed
  // boundary is what stops it — and the boundary is now the course's own stored expiry.
  const agreed = week(5); // what the course row says, however it got there

  test("🔴 a make-up past the agreed boundary is REFUSED — the rule keeps a real job", () => {
    expect(exceedsExtensionCeiling(week(6), agreed)).toBe(true);
    expect(exceedsExtensionCeiling(addDays(agreed, 1), agreed)).toBe(true);
  });

  test("…and one that lands exactly ON it is allowed — the boundary is inclusive (owner-confirmed)", () => {
    expect(exceedsExtensionCeiling(agreed, agreed)).toBe(false);
    expect(exceedsExtensionCeiling(week(4), agreed)).toBe(false);
  });

  test("🚫 the old size-6 rule is unchanged where nothing moved the ceiling", () => {
    // `courseExpiry` is untouched: a size-6 still lands exactly on week 8, and week 9 is still refused. What
    // changed is only where the predicate READS its boundary from.
    const ceiling = courseExpiry(START, 6);
    expect(ceiling).toBe(week(8));
    expect(exceedsExtensionCeiling(ceiling, ceiling)).toBe(false);
    expect(exceedsExtensionCeiling(addDays(ceiling, 7), ceiling)).toBe(true);
  });
});

describe("TASK-299 (a) — §10: the PLAN sets the ceiling at creation", () => {
  // 🚫 Not "skip the check". `courseExpiry(start, 4)` is week 5, computed independently of the plan — so a
  // 4-session course with three declared absences would be born with its plan at week 7 and its ceiling at
  // week 5, and the first post-creation leave refused immediately. **That is DEF-4's shape at creation time.**
  test("🔑 the owner's repro: a 4-session course with THREE declared absences", () => {
    const base = courseExpiry(START, 4); // week 5 = size 4 + quota 1
    expect(base).toBe(week(5));
    const lastPlanned = week(4); // four weekly sessions
    const born = courseBornCeiling(base, lastPlanned, 3);

    // The three make-ups land on weeks 5, 6 and 7 — and the stored ceiling now covers the last of them.
    expect(born).toBe(week(7));
    expect(exceedsExtensionCeiling(week(7), born)).toBe(false);
    // 🔑 Both halves, because either alone is the bug: it CREATES, and its stored expiry covers its own
    // last session.
    expect(born >= week(7)).toBe(true);
  });

  test("a course with NO absences is born with exactly the old ceiling — the common path is untouched", () => {
    const base = courseExpiry(START, 6);
    expect(courseBornCeiling(base, week(6), 0)).toBe(base);
  });

  test("🚫 the ceiling never SHRINKS to the plan — a short plan keeps the MAX_WEEK window", () => {
    // The stretch is one-directional. A course whose plan ends early still owes the family the leave window
    // they bought, so `courseExpiry` remains the floor.
    const base = courseExpiry(START, 10); // week 13
    expect(courseBornCeiling(base, week(3), 0)).toBe(base);
  });
});

describe("TASK-299 (b) — a resumed course is not judged by its purchase date", () => {
  test("🔑 a course bought in July and re-planned into November measures against its NEW expiry", () => {
    // `startDate` deliberately stays the PURCHASE date on resume (TASK-282) — which is right, and is exactly
    // why deriving the ceiling from it refused a legitimate make-up the moment a pause was long enough.
    const purchase = "2026-07-07";
    const derivedFromPurchase = courseExpiry(purchase, 6); // week 8 — long past
    const afterReplan = "2026-12-01"; // TASK-282's derived expiry, covering the re-planned last session

    expect(exceedsExtensionCeiling("2026-11-24", derivedFromPurchase)).toBe(true); // the old defect
    expect(exceedsExtensionCeiling("2026-11-24", afterReplan)).toBe(false); // measured from the agreed plan
  });
});

describe("TASK-299 (c) — §11.2 finally does what the owner asked it for", () => {
  test("🔑 an admin who moves the expiry LATER can then fit the extra session", () => {
    // *"แอดมินสามารถเลื่อนวันหมดอายุคอร์สได้ เพื่อที่อาจจะใส่วัน extra เพิ่มได้"* — he moves the expiry so an
    // extra session FITS. Before this, the predicate never read that column, so the admin moved a date and the
    // rule ignored it.
    const before = courseExpiry(START, 4); // week 5
    const extra = week(6);
    expect(exceedsExtensionCeiling(extra, before)).toBe(true); // refused, as it should be
    const afterAdminEdit = week(8); // PATCH /courses/:id/expiry
    expect(exceedsExtensionCeiling(extra, afterAdminEdit)).toBe(false); // ✅ the edit means something
  });
});

describe("TASK-299 — the wiring, because the pure rule alone would not catch a mis-read", () => {
  const SVC = code(readSrc(readFileSync(resolve(import.meta.dir, "..", "services", "scheduler.service.ts"), "utf8")));

  test("🔑 the reconcile measures against the course's OWN stored expiry", () => {
    // The line that refused a resumed course's make-up. It read `course.startDate, course.size`.
    expect(SVC).toContain("if (exceedsExtensionCeiling(extDate, course.expiryDate)) {");
    expect(SVC).not.toContain("exceedsExtensionCeiling(extDate, course.startDate, course.size)");
  });

  test("🔑 creation STORES the stretched ceiling — computed before the insert, from the plan", () => {
    // Either half alone is the bug: it must create, AND the row it creates must cover its own last session.
    expect(SVC).toContain("const bornCeiling = courseBornCeiling(");
    expect(SVC).toContain("expiryDate: bornCeiling,");
    // …and the plan it is computed from is the one actually inserted, not a second projection.
    expect(SVC).toContain("plannedSessions.reduce((m, s) => (s.date > m ? s.date : m), input.startDate),");
  });

  test("the PREVIEW reports the same ceiling the save will store", () => {
    // 🔴 `exceedsCeiling` is what disabled the owner's `Create plan`. If the preview and the save computed the
    // boundary separately they could disagree — the exact defect class this task is about.
    expect(SVC).toContain("const previewCeiling = courseBornCeiling(");
    expect(SVC).toContain("expiryDate: previewCeiling,");
    expect(SVC).toContain("sessions.some((s) => exceedsExtensionCeiling(s.date, previewCeiling))");
  });

  test("🚫 untouched: `courseExpiry`, the quota, `maxWeek` and the card", () => {
    // `courseExpiry` is still what COMPUTES the boundary a course is born with — it is the floor, not the
    // thing that was wrong.
    expect(SVC).toContain("courseExpiry(input.startDate, input.size),");
    const plan = code(readSrc(readFileSync(resolve(import.meta.dir, "course-plan.ts"), "utf8")));
    expect(plan).toContain("export function courseBornCeiling(");
    // The stretch is the ONLY new arithmetic; nothing here re-implements the week rule.
    expect(plan).not.toContain("MAX_WEEK_BY_SIZE");
    expect(plan).not.toContain("maxWeekFor");
  });
});
