import { describe, expect, test } from "bun:test";
import { correctExpiry, planExpiryRepair, repairSummary, type RepairCourse } from "./expiry-repair-plan";
import { courseExpiry, importedCourseExpiry } from "./recurring";

// FIX-007 / TASK-195. This repair rewrites a column that decides whether a real family reads as EXPIRED, so
// the tests are about the LIST the owner reads before committing — not just the arithmetic.
const TODAY = "2026-08-28";
const c = (o: Partial<RepairCourse> & { id: string }): RepairCourse => ({
  nickname: "น้องเอ",
  // TASK-200: the default is a NATIVE course, because imports are now excluded from the repair entirely — a
  // fixture defaulting to IMPORT would quietly assert nothing at all.
  source: "SALE",
  size: 10,
  priorSessions: 0,
  startDate: "2026-02-05",
  expiryDate: "2026-12-31",
  lastLiveSessionDate: null,
  ...o,
});

describe("correctExpiry picks the rule by source", () => {
  test("an imported course reconstructs its real start", () => {
    expect(correctExpiry(c({ id: "a", source: "IMPORT", priorSessions: 4 }))).toBe(
      importedCourseExpiry("2026-02-05", 10, 4),
    );
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
    const already = c({ id: "ok", expiryDate: courseExpiry("2026-02-05", 10) });
    expect(planExpiryRepair([already], TODAY)).toEqual([]);
  });

  test("🔴 a course that will flip ACTIVE → EXPIRED is marked, and sorted to the top", () => {
    const flips = c({ id: "flip", expiryDate: "2026-12-31" }); // correct expiry is 2026-04-30, in the past
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
    const outlier = c({ id: "out", lastLiveSessionDate: "2026-09-30" }); // correct expiry 2026-04-30
    const [row] = planExpiryRepair([outlier], TODAY);
    expect(row!.liveSessionPastExpiry).toBe("2026-09-30");
    // The change still goes in the list — flagging is extra information, not a reason to drop the row.
    expect(row!.to).toBe("2026-04-30");
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

// ═══ 🔴 TASK-200 — imported courses are NOT touched by the repair ═══
//
// The owner's ruling is "ข้ามการแก้วันexpire คอร์สนำเข้าไปก่อน": an imported expiry is a date a **human typed**,
// and it may encode an agreement with that family no rule of ours can see. The first version of this repair had
// a source-dependent BRANCH inside `correctExpiry`, which made the code look source-aware while still rewriting
// every import — the branch existed; the exclusion did not. These tests assert the OUTCOME, not the branch.
describe("🔴 imports are excluded from the repair entirely (TASK-200)", () => {
  const imported = (id: string, o: Partial<RepairCourse> = {}) =>
    c({ id, source: "IMPORT", priorSessions: 4, ...o });

  test("an imported course whose stored expiry is 'wrong' is still left alone", () => {
    // Deliberately wrong by both rules — it must STILL not appear.
    const row = imported("imp", { expiryDate: "2027-12-31" });
    expect(planExpiryRepair([row], TODAY)).toEqual([]);
  });

  test("🔑 no IMPORT id reaches the change list, the counts, or the flip list, in a mixed set", () => {
    const mixed = [
      imported("imp-1", { expiryDate: "2027-12-31" }),
      imported("imp-2", { expiryDate: "2026-01-01" }), // would have read as newly-expired
      c({ id: "sale-1", expiryDate: "2026-12-31" }),
      c({ id: "sale-2", startDate: "2026-08-01", expiryDate: "2026-08-02" }),
    ];
    const plan = planExpiryRepair(mixed, TODAY);
    expect(plan.map((p) => p.id).sort()).toEqual(["sale-1", "sale-2"]);
    expect(plan.every((p) => p.source !== "IMPORT")).toBe(true);
    // The counts are computed from the plan, so the exclusion has to hold there too — that is the number the
    // owner reads before committing, and it is where a leak would actually do the damage.
    expect(repairSummary(plan).changed).toBe(2);
  });

  test("🔑 a set of ONLY imports produces an empty repair — nothing to read, nothing to commit", () => {
    expect(planExpiryRepair([imported("a"), imported("b"), imported("c")], TODAY)).toEqual([]);
    expect(repairSummary(planExpiryRepair([imported("a")], TODAY))).toEqual({
      changed: 0,
      newlyExpired: 0,
      liveSessionPastExpiry: 0,
      earlier: 0,
      later: 0,
    });
  });

  test("native courses are still repaired — the exclusion is narrow, not a switch-off", () => {
    expect(planExpiryRepair([c({ id: "sale", expiryDate: "2026-12-31" })], TODAY)).toHaveLength(1);
  });

  test("`importedCourseExpiry` is retained and still correct — it is what FUTURE imports should compute", () => {
    // Kept deliberately: what is banned is retro-rewriting rows a human already filled in, not the formula.
    expect(correctExpiry(c({ id: "x", source: "IMPORT", priorSessions: 4 }))).toBe(
      importedCourseExpiry("2026-02-05", 10, 4),
    );
  });
});
