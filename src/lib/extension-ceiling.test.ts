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

    // 🔻 TASK-308 — the three make-ups land on weeks 5, 6 and 7, so the plan ends week 7 and **the ceiling
    // ends week 7 too.** TASK-301's extra quota-week is reverted: with no ceiling left to refuse a leave there
    // is nothing to leave room for, and a pre-allocated week made `expires` claim time nobody had used.
    expect(born).toBe(week(7));
    expect(exceedsExtensionCeiling(week(7), born)).toBe(false);
    // 🔑 Both halves, because either alone is the bug: it CREATES, and its stored expiry covers its own
    // last session.
    expect(born >= week(7)).toBe(true);
  });

  test("a course with NO absences is born with exactly the old ceiling — the common path is untouched", () => {
    // 🔻 TASK-308 — with the quota term reverted the stretch is `lastPlanned + absences`, so an absence-free
    // course stretches by nothing and `courseExpiry` remains the floor. **The common path is untouched, which
    // is the property this test has always protected.**
    const base = courseExpiry(START, 6);
    expect(base).toBe(week(8));
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
    // 🔻 TASK-308 (REQ-085 §12) — **the reconcile no longer measures against ANY ceiling.** The refusal was
    // deleted: the quota is the only gate on leave, and the expiry STRETCHES to fit instead. TASK-299 made
    // this line read the right boundary and TASK-301 made it name the right date — 🔑 **but an accurate
    // refusal is still a refusal, and the requirement was never a better one.**
    expect(SVC).not.toContain("exceedsExtensionCeiling(extDate,");
    expect(SVC).toContain("if (extDate > expiryAfterAppends) expiryAfterAppends = extDate;");
  });

  test("🔑 creation STORES the stretched ceiling — computed before the insert, from the plan", () => {
    // Either half alone is the bug: it must create, AND the row it creates must cover its own last session.
    expect(SVC).toContain("const bornCeiling = courseBornCeiling(");
    expect(SVC).toContain("expiryDate: bornCeiling,");
    // …and the plan it is computed from is the one actually inserted, not a second projection.
    expect(SVC).toContain("plannedSessions.reduce((m, s) => (s.date > m ? s.date : m), input.startDate),");
  });

  test("the PREVIEW reports the boundary the plan it describes actually needs", () => {
    // 🔴 `exceedsCeiling` is what disabled the owner's `Create plan`.
    // 🔻 TASK-309 §2 — the boundary is now WIDENED to the sessions the preview actually laid out, make-ups
    // included, rather than to a weekly PROJECTION of them. The projection was the defect: it assumed a cadence
    // while `findFreeExtensionDate` searches, so a taken slot pushed a real make-up past it.
    // 🔑 Preview and save still agree — from the other side: TASK-308 grows the stored expiry to cover the
    // make-ups the reconcile appends, so both land on the finished course's own last date.
    expect(SVC).toContain("const previewCeiling = sessions.reduce(");
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
describe("🔻 TASK-308 (REQ-085 §12) — the ceiling may NEVER refuse a leave, and these assertions record why", () => {
  // 🔴 **Both TASK-301 describes lived here and are REWRITTEN.** They asserted that the ceiling left exactly
  // the quota's room beyond the plan, and that its refusal named the right date. **The refusal is gone.**
  //
  // The owner, verbatim: *"quota ลา มี แต่การยืดเวลาไม่มี quota … ส่วนวันหมดอายุ ก็อย่างที่บอก ให้ยืดตามไปเลย"*
  // ⇒ **the QUOTA is the only gate on leave; the expiry stretches to fit.** TASK-299 made the refusal read the
  // right boundary and TASK-301 made it name the right date — 🔑 **but an accurate refusal is still a refusal,
  // and the owner reported the same outcome three times.**
  // 📌 @Porter has withdrawn the two-rule reading as his own misreading: **the ceiling was never a rule about
  // leave; it was a rule we invented for it.**

  test("🔑 the reconcile no longer measures a make-up against ANY ceiling", () => {
    const SVC = code(readSrc(readFileSync(resolve(import.meta.dir, "..", "services", "scheduler.service.ts"), "utf8")));
    expect(SVC).not.toContain("exceedsExtensionCeiling(extDate,");
    expect(SVC).not.toContain("EXTENSION_CEILING");
  });

  test("✅ …and the expiry GROWS instead, through the one writer an admin edit uses", () => {
    // 🚫 Not a second way to move an expiry: REQ-082's audit still answers *"why did this date move?"*
    const SVC = code(readSrc(readFileSync(resolve(import.meta.dir, "..", "services", "scheduler.service.ts"), "utf8")));
    expect(SVC).toContain("if (extDate > expiryAfterAppends) expiryAfterAppends = extDate;");
    expect(SVC).toContain("await recordExpiryChange(tx, {");
  });

  test("🔑 the bound the ceiling was protecting still exists — and it is the QUOTA", () => {
    // `SPEC-028 §5 #2` feared *"a leave could otherwise extend a course indefinitely"*. **It cannot: a course
    // earns at most `quota` make-ups, ever.** ⇒ the quota was always the real bound, and the ceiling was a
    // second answer to a question that already had one.
    // ⚠️ Asserted as the gate that REMAINS, so *"no ceiling"* cannot quietly become *"no limit"*.
    const SVC = code(readSrc(readFileSync(resolve(import.meta.dir, "..", "services", "scheduler.service.ts"), "utf8")));
    expect(SVC).toContain("toCourseSummary(course).leaveLocked");
    expect(SVC).toContain("canTakeLeave(current.course)");
  });

  test("🚫 the predicate itself is NOT dead — one live caller, named", () => {
    // §4 asked whether `exceedsExtensionCeiling` still has a caller. **It does: the creation preview's
    // `exceedsCeiling`**, which the FE reads to disable `Create plan` (§6). ⚠️ And it is REACHABLE — the
    // preview projects make-ups at a weekly cadence while `findFreeExtensionDate` SEARCHES, so a taken slot
    // can still push one past the projection. 🚫 Left in place: removing it would change a DTO the FE reads.
    const SVC = code(readSrc(readFileSync(resolve(import.meta.dir, "..", "services", "scheduler.service.ts"), "utf8")));
    expect(SVC.match(/exceedsExtensionCeiling\(/g)).toHaveLength(1);
    expect(SVC).toContain("exceedsCeiling: sessions.some((s) => exceedsExtensionCeiling(s.date, previewCeiling))");
  });
});

describe("🔑 TASK-308 — the owner's `มิลล่า`, and his screenshot IS the acceptance test", () => {
  const SVC = code(readSrc(readFileSync(resolve(import.meta.dir, "..", "services", "scheduler.service.ts"), "utf8")));
  const append = SVC.slice(SVC.indexOf("for (const a of plan.append) {"), SVC.indexOf("return { appended, cancelled };"));

  test("🔴 a 4-session course, 3 declared absences, plan ending week 7 — the leave GOES THROUGH", () => {
    // He hit this three times. Before: `คอร์สขยายเกินสัปดาห์ที่ 5 ไม่ได้`. After TASK-301:
    // `คอร์สขยายเกินวันสิ้นสุดของคอร์ส (2026-10-27) ไม่ได้`. 🔑 **The refusal moved and the outcome did not.**
    // The plan ends week 7, its make-up needs week 8, and nothing in the append path refuses it now.
    const born = courseBornCeiling(courseExpiry(START, 4), week(4), 3);
    expect(born).toBe(week(7));
    expect(append).not.toContain("throw");
    expect(append).not.toContain("exceedsExtensionCeiling");
  });

  test("🔑 …AND the expiry MOVES to cover it — the other half, because either alone is the defect", () => {
    // ⚠️ *"The leave succeeding with a stale expiry is the same defect wearing a different face."* The append
    // collects the furthest date and the expiry grows to it, once, through `recordExpiryChange`.
    expect(append).toContain("if (extDate > expiryAfterAppends) expiryAfterAppends = extDate;");
    expect(SVC).toContain("if (expiryAfterAppends > course.expiryDate) {");
    expect(SVC).toContain(".set({ expiryDate: expiryAfterAppends })");
  });

  test("🔑 a course with NO quota left is STILL REFUSED — the gate that remains", () => {
    // ⚠️ Without this, *"no ceiling"* becomes *"no limit"*. The quota is now the only gate, and both of its
    // doors still hold: the per-session leave and the plan editor's `mark-absence`.
    expect(SVC).toContain("if (canTakeLeave(current.course)) {");
    expect(SVC).toContain("toCourseSummary(course).leaveLocked");
    expect(SVC).toContain('conflict("LEAVE_LOCKED"');
  });

  test("🚫 `EXTENSION_CEILING` is gone from the service entirely — including its catch", () => {
    // 📌 The `CANCEL_AT_CEILING` re-map caught it on the cancel path. With nothing left to throw it, that catch
    // was a handler for an exception that cannot arrive — §4's own rule, and `EXPIRY_REQUIRED`'s shape.
    expect(SVC).not.toContain("EXTENSION_CEILING");
    expect(SVC).not.toContain("CANCEL_AT_CEILING");
    // ✅ …and the reconcile still RUNS on a cancel: every course-session cancel is a reschedule, not a forfeit.
    expect(SVC).toContain("await reconcileCoursePlan(tx, current.courseId);");
  });

  test("✅ §10's creation stretch for DECLARED absences survives this", () => {
    // 🚫 Those are real planned sessions and must stay covered — the revert took only the quota term.
    expect(courseBornCeiling(courseExpiry(START, 4), week(4), 3)).toBe(week(7));
    expect(courseBornCeiling(courseExpiry(START, 4), week(4), 0)).toBe(week(5)); // no absences ⇒ the base
  });
});
