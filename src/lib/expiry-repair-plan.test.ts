import { describe, expect, test } from "bun:test";
import { correctExpiry, planExpiryRepair, repairSummary, type RepairCourse } from "./expiry-repair-plan";
import { courseExpiry, importedCourseExpiry } from "./recurring";

// FIX-007 / TASK-195. This repair rewrites a column that decides whether a real family reads as EXPIRED, so
// the tests are about the LIST the owner reads before committing — not just the arithmetic.
const TODAY = "2026-08-28";
const c = (o: Partial<RepairCourse> & { id: string }): RepairCourse => ({
  nickname: "น้องเอ",
  source: "IMPORT",
  size: 10,
  priorSessions: 4,
  startDate: "2026-02-05",
  expiryDate: "2026-12-31",
  lastLiveSessionDate: null,
  ...o,
});

describe("correctExpiry picks the rule by source", () => {
  test("an imported course reconstructs its real start", () => {
    expect(correctExpiry(c({ id: "a" }))).toBe(importedCourseExpiry("2026-02-05", 10, 4));
  });

  test("a native course counts from its own start — priorSessions is 0 there anyway", () => {
    expect(correctExpiry(c({ id: "b", source: "SALE", priorSessions: 0 }))).toBe(
      courseExpiry("2026-02-05", 10),
    );
  });

  test("🔑 a native course is NEVER run through the import rule, even if its priorSessions were wrong", () => {
    // Defensive: a stray non-zero prior on a SALE row must not shorten a paying family's course.
    expect(correctExpiry(c({ id: "b", source: "SALE", priorSessions: 3 }))).toBe(
      courseExpiry("2026-02-05", 10),
    );
  });
});

describe("🔴 the dry-run list is the deliverable", () => {
  test("only courses whose expiry actually moves are listed", () => {
    const already = c({ id: "ok", expiryDate: importedCourseExpiry("2026-02-05", 10, 4) });
    expect(planExpiryRepair([already], TODAY)).toEqual([]);
  });

  test("🔴 a course that will flip ACTIVE → EXPIRED is marked, and sorted to the top", () => {
    const flips = c({ id: "flip", expiryDate: "2026-12-31" }); // correct expiry is 2026-04-09, in the past
    const moves = c({ id: "moves", startDate: "2026-08-01", priorSessions: 0, expiryDate: "2027-01-01" });
    const plan = planExpiryRepair([moves, flips], TODAY);
    expect(plan[0]!.id).toBe("flip");
    expect(plan[0]!.newlyExpired).toBe(true);
    expect(plan[1]!.newlyExpired).toBe(false);
  });

  test("'newly expired' means the STATUS flips — not merely that the date moved earlier", () => {
    // A course already past its old expiry is not news; listing it as newly-expired would bury the real cases.
    const alreadyExpired = c({ id: "old", expiryDate: "2026-01-01" });
    expect(planExpiryRepair([alreadyExpired], TODAY)[0]!.newlyExpired).toBe(false);
  });

  test("🔑 AC-4: a live session past the corrected expiry is FLAGGED, never moved or hidden", () => {
    const outlier = c({ id: "out", lastLiveSessionDate: "2026-09-30" }); // correct expiry 2026-04-09
    const [row] = planExpiryRepair([outlier], TODAY);
    expect(row!.liveSessionPastExpiry).toBe("2026-09-30");
    // The change still goes in the list — flagging is extra information, not a reason to drop the row.
    expect(row!.to).toBe("2026-04-09");
  });

  test("a live session inside the corrected window is not flagged", () => {
    expect(
      planExpiryRepair([c({ id: "in", lastLiveSessionDate: "2026-03-01" })], TODAY)[0]!
        .liveSessionPastExpiry,
    ).toBeNull();
  });

  test("🔑 AC-6: re-running over the repaired data finds nothing", () => {
    const before = [c({ id: "a" }), c({ id: "b", source: "SALE", priorSessions: 0 })];
    const after = before.map((x) => ({ ...x, expiryDate: correctExpiry(x) }));
    expect(planExpiryRepair(after, TODAY)).toEqual([]);
  });

  test("the summary counts what the owner needs to decide with — before any name", () => {
    const plan = planExpiryRepair(
      [
        c({ id: "flip" }),
        c({ id: "later", startDate: "2026-08-01", priorSessions: 0, expiryDate: "2026-08-02" }),
        c({ id: "out", lastLiveSessionDate: "2026-09-30" }),
      ],
      TODAY,
    );
    const s = repairSummary(plan);
    expect(s.changed).toBe(3);
    expect(s.newlyExpired).toBe(2);
    expect(s.liveSessionPastExpiry).toBe(1);
    expect(s.earlier + s.later).toBe(3);
  });
});
