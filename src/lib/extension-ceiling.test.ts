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
    const born = courseBornCeiling(base, lastPlanned, 3, 1);

    // The three make-ups land on weeks 5, 6 and 7, so the PLAN ends at week 7 — and the ceiling sits a
    // quota-week beyond it (TASK-301), which is what the base ceiling gives an absence-free course.
    expect(born).toBe(week(8));
    expect(exceedsExtensionCeiling(week(7), born)).toBe(false);
    // 🔑 Both halves, because either alone is the bug: it CREATES, and its stored expiry covers its own
    // last session.
    expect(born >= week(7)).toBe(true);
  });

  test("a course with NO absences is born with exactly the old ceiling — the common path is untouched", () => {
    // 🔑 And this is the check that the TASK-301 term is the RIGHT one rather than merely more room: with no
    // absences the formula is `lastPlanned + quota weeks`, which IS `courseExpiry`. The two agree by
    // arithmetic, not by coincidence — week 6 + 2 = week 8 = the base.
    const base = courseExpiry(START, 6);
    expect(base).toBe(week(8));
    expect(courseBornCeiling(base, week(6), 0, 2)).toBe(base);
  });

  test("🚫 the ceiling never SHRINKS to the plan — a short plan keeps the MAX_WEEK window", () => {
    // The stretch is one-directional. A course whose plan ends early still owes the family the leave window
    // they bought, so `courseExpiry` remains the floor.
    const base = courseExpiry(START, 10); // week 13
    expect(courseBornCeiling(base, week(3), 0, 3)).toBe(base);
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

// ═══ TASK-301 — the stretched ceiling left NO room for the quota leave the card promises ═══
//
// 🔴 Screen-verified by the owner on `sid`, on the deployed TASK-299. **TASK-299 is correct; its arithmetic was
// one term short.** `courseBornCeiling` stretched from `lastPlanned` by the ABSENCES only, so the quota's week
// — which the base ceiling has always included — was dropped.
// ⇒ §10 handed the admin unlimited absences at creation and **silently took away the one leave the family had
// afterwards.** The card said `Leave 0/1` and the course could not use it.
describe("🔑 TASK-301 — a course can still take the quota leave its card promises", () => {
  const QUOTA_4 = 1; // LEAVE_QUOTA_BY_SIZE[4]

  test("🔴 the owner's `มิลล่า`: 4 sessions, 3 declared absences, then its quota leave FITS", () => {
    // The plan ends at week 7 (four booked + three make-ups). The leave marked afterwards needs a make-up in
    // week 8 — which is the one the card was already promising.
    const born = courseBornCeiling(courseExpiry(START, 4), week(4), 3, QUOTA_4);
    expect(exceedsExtensionCeiling(week(8), born)).toBe(false);
  });

  test("🔑 …and a SECOND leave is still REFUSED — the boundary must still exist", () => {
    // ⚠️ The assertion that stops a fix for "no room" becoming "no ceiling". The quota is ONE; the room is one
    // week; the second make-up would need week 9 and does not get it.
    const born = courseBornCeiling(courseExpiry(START, 4), week(4), 3, QUOTA_4);
    expect(exceedsExtensionCeiling(week(9), born)).toBe(true);
  });

  test("🚫 this grants no EXTRA leave — the room equals the quota, exactly", () => {
    // A size-6 (quota 2) with one absence: plan ends week 7, and the room is two weeks, not three.
    const born = courseBornCeiling(courseExpiry(START, 6), week(6), 1, 2);
    expect(born).toBe(week(9));
    expect(exceedsExtensionCeiling(week(9), born)).toBe(false); // both quota leaves fit
    expect(exceedsExtensionCeiling(week(10), born)).toBe(true); // a third does not
  });

  test("🔑 the property, stated once: the ceiling always leaves the quota's room beyond the plan", () => {
    // @Sober's Question. Nobody had tested *"can a course still use the quota it is shown?"* — we tested that
    // the ceiling stretched, that it still refused, and that an admin edit worked.
    for (const [size, quota] of [
      [4, 1],
      [6, 2],
      [10, 3],
    ] as const) {
      for (const absences of [0, 1, 2, 3]) {
        const lastPlanned = week(size);
        const born = courseBornCeiling(courseExpiry(START, size), lastPlanned, absences, quota);
        const planEnd = addDays(lastPlanned, absences * 7);
        // Room beyond the plan's own end, in weeks, is never less than the quota.
        expect({ size, absences, ok: born >= addDays(planEnd, quota * 7) }).toEqual({
          size,
          absences,
          ok: true,
        });
      }
    }
  });
});

describe("🔴 TASK-301 — the refusal names the boundary the CHECK used", () => {
  const SVC2 = code(readSrc(readFileSync(resolve(import.meta.dir, "..", "services", "scheduler.service.ts"), "utf8")));

  test("🔑 it prints the course's OWN ceiling, not a constant from the size", () => {
    // The check reads `course.expiryDate`; the message printed `MAX_WEEK_BY_SIZE[size]`. A course refused at
    // week 7 was told the limit was week 5 — and that sentence sent @Porter to the wrong diagnosis.
    expect(SVC2).toContain("`คอร์สขยายเกินวันสิ้นสุดของคอร์ส (${course.expiryDate}) ไม่ได้`");
  });

  test("⚠️ …and it can no longer print a week number derived from the SIZE", () => {
    // Asserted as an absence on the refusal itself: this is the exact thing that misled us, and a week number
    // from anything but the ceiling would bring the defect back with different digits.
    const block = SVC2.slice(SVC2.indexOf('"EXTENSION_CEILING",'));
    const refusal = block.slice(0, block.indexOf("\n"));
    expect(SVC2).not.toContain("MAX_WEEK_BY_SIZE[course.size]");
    expect(refusal).not.toContain("5");
  });
});
