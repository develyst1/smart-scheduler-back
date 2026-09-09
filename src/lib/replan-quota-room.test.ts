// TASK-302 — a RE-PLANNED course had no room for the quota it still has.
//
// 🔴 `replanExpiry` returned the last planned session EXACTLY, and TASK-299 then made that value the extension
// ceiling ⇒ **zero headroom, and the next quota leave refused.** A pause of a few weeks almost always ends
// later than the original expiry, so this fired on the ordinary path: **the family paused, came back, and lost
// the leave they had not used.** 🔑 TASK-301's defect, one verb over.
//
// ⚠️ **REMAINING quota, not full** — that is the whole difference between a promise and a gift.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { courseBornCeiling, exceedsExtensionCeiling, replanExpiry } from "./course-plan";
import { addDays } from "./time";
import { courseExpiry, importedCourseExpiry } from "./recurring";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const OLD_EXPIRY = "2026-10-20";
const LAST = "2026-12-01"; // the re-plan's last session, past the old expiry
const wk = (from: string, n: number) => addDays(from, n * 7);

describe("🔑 TASK-302 — a resumed course can take the leave it still has. Written first.", () => {
  test("🔴 unused quota ⇒ the ceiling reaches PAST the last session, and the leave fits", () => {
    // A size-6 course with both leaves unspent: the make-up for a leave taken after the resume needs the week
    // after the plan's end, and that is exactly what the card has been promising all along.
    const expiry = replanExpiry(OLD_EXPIRY, LAST, 2);
    expect(expiry).toBe(wk(LAST, 2));
    expect(exceedsExtensionCeiling(wk(LAST, 1), expiry)).toBe(false);
    expect(exceedsExtensionCeiling(wk(LAST, 2), expiry)).toBe(false);
  });

  test("🔑 quota SPENT ⇒ no extra room — the assertion that keeps it a promise, not a gift", () => {
    // ⚠️ "Remaining" is the whole difference. A course with nothing left to take is given nothing, and the
    // boundary lands on its last session exactly, as it did before this task.
    const expiry = replanExpiry(OLD_EXPIRY, LAST, 0);
    expect(expiry).toBe(LAST);
    expect(exceedsExtensionCeiling(wk(LAST, 1), expiry)).toBe(true);
  });

  test("…and PARTLY spent gets partly the room — one leave left, one week", () => {
    const expiry = replanExpiry(OLD_EXPIRY, LAST, 1);
    expect(expiry).toBe(wk(LAST, 1));
    expect(exceedsExtensionCeiling(wk(LAST, 1), expiry)).toBe(false);
    expect(exceedsExtensionCeiling(wk(LAST, 2), expiry)).toBe(true);
  });
});

describe("TASK-302 — what must NOT have changed", () => {
  test("🚫 the expiry still COVERS the last planned session — DEF-4's guarantee", () => {
    // The thing TASK-282 exists for. Whatever the quota adds, it can never leave the last session outside.
    for (const q of [0, 1, 2, 3]) {
      expect(replanExpiry(OLD_EXPIRY, LAST, q) >= LAST).toBe(true);
    }
  });

  test("🚫 it still never SHRINKS — a re-plan finishing early leaves the old expiry alone", () => {
    // Shrinking would take back a window the family already had, as a side effect of an admin rescheduling.
    expect(replanExpiry("2026-12-31", "2026-11-24", 2)).toBe("2026-12-31");
    // …and `recordExpiryChange` then writes nothing, because `from === to`.
    const SVC = code(src("src/services/scheduler.service.ts"));
    // …sliced to the brace at COLUMN ZERO: the parameter type is an inline object, so a plain `indexOf("}")`
    // ends the slice inside the signature and the assertion below would fail on a truncation.
    const writer = SVC.slice(SVC.indexOf("async function recordExpiryChange("));
    expect(writer.slice(0, writer.indexOf("\n}"))).toContain("if (row.from === row.to) return;");
  });

  test("nothing owed ⇒ no last session ⇒ nothing moves, whatever the quota says", () => {
    expect(replanExpiry("2026-12-31", null, 3)).toBe("2026-12-31");
  });

  test("🔑 ONE arithmetic for one sentence — `replanExpiry` IS `courseBornCeiling` with no absences", () => {
    // 🚫 Two arithmetics for one promise is the class this week has been about. A re-plan declares no
    // absences, so the two are the same function called with `absences = 0` — asserted by AGREEMENT, so a
    // change to either that does not change the other fails here.
    for (const q of [0, 1, 2, 3]) {
      expect(replanExpiry(OLD_EXPIRY, LAST, q)).toBe(courseBornCeiling(OLD_EXPIRY, LAST, 0, q));
    }
    expect(code(src("src/lib/course-plan.ts"))).toContain(
      "lastSession ? courseBornCeiling(currentExpiry, lastSession, 0, remainingQuota) : currentExpiry;",
    );
  });

  test("🚫 the quota and `leaveUsed` are read, never written", () => {
    // This task gives a course ROOM for the leave it has; it does not grant leaves.
    const SVC = code(src("src/services/scheduler.service.ts"));
    const resume = SVC.slice(
      SVC.indexOf("export async function resumeCourse("),
      SVC.indexOf("export async function endCourse("),
    );
    expect(resume).toContain("Math.max(0, courseLeaveQuota(course) - course.leaveUsed)");
    expect(resume).not.toContain("leaveUsed:");
    expect(resume).not.toContain("leaveQuota:");
  });
});

describe("🔑 TASK-302 Question — the property ACROSS the lifecycle, not per entry point", () => {
  // @Sober's shape, and it holds: **every path that COMPUTES the boundary keeps the promise; the one path
  // where a PERSON chooses it does not.** Asserted over the three computing paths at once, so a fourth
  // entry point added without the promise fails here rather than on a family's calendar.
  const START = "2026-09-01";
  const week = (n: number) => addDays(START, (n - 1) * 7);
  /** The promise, in one place: the ceiling reaches the plan's end plus the remaining quota, in weeks. */
  const keepsPromise = (ceiling: string, planEnd: string, remaining: number) =>
    ceiling >= addDays(planEnd, remaining * 7);

  test("CREATED · IMPORTED · RE-PLANNED all keep it", () => {
    const rows = [
      // Created with declared absences (TASK-301): plan ends `size + absences`, ceiling reaches past it.
      {
        path: "created",
        ceiling: courseBornCeiling(courseExpiry(START, 4), week(4), 3, 1),
        planEnd: week(7),
        remaining: 1,
      },
      // Imported: `importedCourseExpiry` reconstructs the real start and calls `courseExpiry`, which IS
      // `plan end + quota` — the same promise kept by a different expression, and the one place it is.
      {
        path: "imported",
        ceiling: importedCourseExpiry(START, 6, 0, 2),
        planEnd: week(6),
        remaining: 2,
      },
      // Re-planned (this task): the last session plus whatever leave the family has left.
      {
        path: "replanned",
        ceiling: replanExpiry("2026-10-20", LAST, 2),
        planEnd: LAST,
        remaining: 2,
      },
    ];
    expect(rows.map((r) => ({ path: r.path, ok: keepsPromise(r.ceiling, r.planEnd, r.remaining) }))).toEqual([
      { path: "created", ok: true },
      { path: "imported", ok: true },
      { path: "replanned", ok: true },
    ]);
  });

  test("⚪ …and the ADMIN EDIT is the deliberate exception the property must carve out", () => {
    // `updateCourseExpiry` writes the request verbatim — a PERSON chose the boundary, and TASK-299's rule is
    // that the ceiling yields to a deliberate act. An admin may set it inside the course's own quota.
    const chosen = week(5); // a date an admin typed, with the plan ending week 7
    expect(keepsPromise(chosen, week(7), 1)).toBe(false);
    // 🔴 NAMED, not built (TASK-302's Question): **nothing warns them.** `expiryImpact` reports the SESSIONS
    // that would fall outside the new date — it says nothing about the leave the family still has, so an
    // admin can silently spend a course's remaining quota by moving one date.
    const SVC = code(src("src/services/scheduler.service.ts"));
    const edit = SVC.slice(SVC.indexOf("export async function updateCourseExpiry("));
    expect(edit.slice(0, edit.indexOf("\n}"))).not.toContain("leaveUsed");
  });
});
