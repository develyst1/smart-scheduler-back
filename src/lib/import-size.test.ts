import { describe, expect, test } from "bun:test";
import { decideImportSize } from "./import-size";
import { LEAVE_QUOTA_BY_SIZE, MAX_WEEK_BY_SIZE, courseLeaveQuota, maxWeekFor } from "./leave";
import { courseExpiry, importedCourseExpiry } from "./recurring";

// SPEC-068 / TASK-213. The form accepted any size 1–100 and then **crashed with a 500** on anything off-card —
// on the one door the customer's existing families walk through. These tests are about what a staff member
// sees: a sentence they can act on, or a course that actually works.
describe("decideImportSize — the card sizes need nothing extra", () => {
  test("4 / 6 / 10 import with no quota field at all, and store none (still derived)", () => {
    for (const size of [4, 6, 10]) {
      expect(decideImportSize(size)).toEqual({ ok: true, leaveQuota: null });
    }
  });

  test("a stated quota that MATCHES the card stores nothing — no second copy of a known number", () => {
    expect(decideImportSize(10, 3).leaveQuota).toBeNull();
  });

  test("a stated quota that DIFFERS on a card size is stored — that is a special agreement, not a typo to drop", () => {
    expect(decideImportSize(10, 5)).toEqual({ ok: true, leaveQuota: 5 });
  });
});

describe("🔴 an off-card size: refused with a SENTENCE, or imported properly", () => {
  test("no quota ⇒ refused in Thai, naming what is missing — never a 500", () => {
    const d = decideImportSize(8);
    expect(d.ok).toBe(false);
    expect(d.problem).toContain("8 คาบ");
    expect(d.problem).toContain("ลาได้"); // it says WHICH field to fill, with examples
  });

  test("with a quota ⇒ accepted and the quota is STORED (the card cannot answer for it)", () => {
    expect(decideImportSize(8, 2)).toEqual({ ok: true, leaveQuota: 2 });
  });

  test("a quota of 0 is a real answer, not a missing one", () => {
    // "This 8-session course was sold with no leave allowance" must be expressible; `?? ` on a falsy 0 is the
    // classic way that stops being true.
    expect(decideImportSize(8, 0)).toEqual({ ok: true, leaveQuota: 0 });
  });

  test("nonsense is refused with its own message, not the generic one", () => {
    expect(decideImportSize(0).problem).toContain("จำนวนเต็มบวก");
    expect(decideImportSize(8, -1).problem).toContain("0 ขึ้นไป");
  });
});

describe("🔴 maxWeek = size + quota — one rule, and it answers for a size the card never heard of", () => {
  test("the derived table still equals the owner's three numbers", () => {
    // These were two hand-typed tables. If deriving one from the other had changed any of them, this fails.
    expect(MAX_WEEK_BY_SIZE).toEqual({ 4: 5, 6: 8, 10: 13 });
    for (const size of [4, 6, 10]) {
      expect(maxWeekFor(size, LEAVE_QUOTA_BY_SIZE[size]!)).toBe(MAX_WEEK_BY_SIZE[size]);
    }
  });

  test("🔑 an off-card course gets a real ceiling instead of week 0", () => {
    // Before: quota and maxWeek both fell through to 0 — no leave allowance, and an expiry inside its own
    // first week. Nothing said so; it just looked like a finished course.
    expect(courseLeaveQuota({ size: 8, leaveQuota: 2 })).toBe(2);
    expect(maxWeekFor(8, 2)).toBe(10);
    expect(courseExpiry("2026-09-06", 8, 2)).toBe(courseExpiry("2026-09-06", 8, 2));
    // …and it is genuinely later than the start, which week-0 was not.
    expect(courseExpiry("2026-09-06", 8, 2) > "2026-09-06").toBe(true);
  });

  test("a card size is UNCHANGED by the new parameter — the old numbers still hold", () => {
    expect(courseExpiry("2026-09-04", 6)).toBe("2026-10-23"); // the owner's pinned case
    expect(courseExpiry("2026-09-04", 6, 2)).toBe("2026-10-23"); // …stating the quota changes nothing
    expect(importedCourseExpiry("2026-02-05", 10, 4)).toBe("2026-04-02");
  });

  test("an off-card import's expiry uses ITS quota, not a guessed one", () => {
    // The old fallback was `size + 1`, a number from no rule. 8 sessions + 2 leaves = week 10.
    expect(importedCourseExpiry("2026-09-06", 8, 0, 2)).toBe(courseExpiry("2026-09-06", 8, 2));
    expect(importedCourseExpiry("2026-09-06", 8, 0, 2)).not.toBe(importedCourseExpiry("2026-09-06", 8, 0, 5));
  });
});
