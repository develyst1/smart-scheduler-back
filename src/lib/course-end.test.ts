import { describe, expect, test } from "bun:test";
import {
  COURSE_LIVE,
  COURSE_LIVE_STATUSES,
  END_REASONS,
  ENDABLE_STATUSES,
  canInsertIntoCourse,
  courseCurrent,
  courseOwedTarget,
  endableSessions,
  isCourseEnded,
  isEndReason,
  planCourseMovesForCourse,
  type PlanSession,
} from "./course-plan";
import { toCourseSummary } from "./leave";

// SPEC-064 / TASK-181 (REQ-036). R4's headline check is #1: **a make-up must never be re-owed**. These tests
// are written against that specific failure — an ended course that later looks "short" to the reconciler and
// quietly appends the very sessions the family forfeited.
const s = (id: string, status: string, date: string): PlanSession => ({
  id,
  status,
  date,
  extendedFromId: null,
  bookingType: "COURSE_PACKAGE",
});

/** A 10-session course, 3 delivered, 7 still to come — the shape of the customer who is waiting. */
const sessions = [
  s("b1", "ATTENDED", "2026-08-03"),
  s("b2", "ATTENDED", "2026-08-10"),
  s("b3", "SICK_LEAVE", "2026-08-17"),
  s("b4", "CONFIRMED", "2026-08-24"),
  s("b5", "CONFIRMED", "2026-08-31"),
  s("b6", "PENDING", "2026-09-07"),
  s("b7", "PENDING", "2026-09-14"),
];
const live = { size: 10, priorSessions: 0 };
const ended = { ...live, endedAt: new Date("2026-08-24T10:00:00Z") };

describe("🔴 R4.1 — no make-up is ever re-owed (the check that matters)", () => {
  test("an ENDED course plans NO moves — nothing appended, nothing cancelled", () => {
    // The failure this prevents: after the ending soft-cancels 4 sessions, `courseCurrent` reads 3 against a
    // plan size of 10, the reconciler calls that "short by 7" and appends make-ups for the forfeited sessions.
    const remaining = sessions.filter((x) => !["b4", "b5", "b6", "b7"].includes(x.id));
    expect(planCourseMovesForCourse(ended, remaining)).toEqual({ append: [], cancelIds: [] });
    // …and the same course NOT ended would indeed have re-owed them, which is why the guard exists:
    expect(planCourseMovesForCourse(live, remaining).append.length).toBeGreaterThan(0);
  });

  test("owedCount is 0 for an ended course — by construction, not by luck", () => {
    const remaining = sessions.filter((x) => !["b4", "b5", "b6", "b7"].includes(x.id));
    expect(Math.max(0, courseOwedTarget(ended) - courseCurrent(remaining))).toBe(0);
    expect(courseOwedTarget(ended)).toBe(0);
  });

  test("insertable is false for an ended course, whatever its sessions look like", () => {
    // Staff clicking Insert is exactly how a re-owe would have happened in practice.
    expect(canInsertIntoCourse(ended, sessions)).toBe(false);
    expect(canInsertIntoCourse(live, sessions)).toBe(true); // the same course, not ended, still allows it
  });

  test("the guard keys on presence, not truthiness — any timestamp closes the plan", () => {
    expect(isCourseEnded({ size: 10, endedAt: "2026-08-24T10:00:00Z" })).toBe(true);
    expect(isCourseEnded({ size: 10, endedAt: null })).toBe(false);
    expect(isCourseEnded({ size: 10 })).toBe(false);
  });

  test("🔑 an ended IMPORT course still owes 0 — the two guards compose, they don't fight", () => {
    expect(courseOwedTarget({ size: 10, priorSessions: 4, endedAt: new Date() })).toBe(0);
    expect(courseOwedTarget({ size: 10, priorSessions: 4 })).toBe(6); // REQ-064 unchanged when not ended
  });
});

describe("R4.2 — what an ending touches, and what it must not", () => {
  test("only the sessions that have not happened are removed", () => {
    expect(endableSessions(sessions).map((x) => x.id)).toEqual(["b4", "b5", "b6", "b7"]);
  });

  test("🔴 DELIVERED rows are never in the set — attended, no-show, leave, already-cancelled", () => {
    // Ending a course forfeits what has not happened. It never rewrites what did: a family's history must read
    // the same afterwards as before — including the sick leave that earned the make-up we are cancelling.
    const untouchable = [
      s("a", "ATTENDED", "2026-08-03"),
      s("n", "NO_SHOW", "2026-08-06"),
      s("l", "SICK_LEAVE", "2026-08-10"),
      s("c", "CANCELLED", "2026-08-17"),
    ];
    expect(endableSessions(untouchable)).toEqual([]);
  });

  test("🔴 an appended EXTENDED make-up IS removed — the gap Sober caught in review", () => {
    // I first wrote PENDING+CONFIRMED. An EXTENDED is a real future booking on a teacher's calendar, it is not
    // slot-non-blocking, and getCalendar hides only CANCELLED — so leaving it would strand a ghost session
    // holding a slot on **every course that has ever taken a leave**, which is the commonest path there is.
    expect(endableSessions([s("e", "EXTENDED", "2026-09-21")]).map((x) => x.id)).toEqual(["e"]);
  });

  test("🔑 the real case end to end: a course with a leave → make-up, ended ⇒ nothing live is left", () => {
    const withMakeup = [
      s("b1", "ATTENDED", "2026-08-03"),
      s("b2", "SICK_LEAVE", "2026-08-10"), // the leave stays — it is history
      s("b3", "CONFIRMED", "2026-08-17"),
      s("b4", "EXTENDED", "2026-09-21"), // …its make-up does not — it is a future slot
    ];
    const removed = endableSessions(withMakeup).map((x) => x.id);
    expect(removed).toEqual(["b3", "b4"]);
    // Nothing LIVE survives the ending, so no slot stays blocked and no session stays on the calendar.
    const left = withMakeup.filter((x) => !removed.includes(x.id));
    expect(left.some((x) => COURSE_LIVE.has(x.status))).toBe(false);
  });

  test("the endable set IS the live set — not a second list that can drift", () => {
    expect([...ENDABLE_STATUSES]).toEqual([...COURSE_LIVE_STATUSES]);
  });

  test("a soft-linked single-session extra is not part of the course plan and is left alone", () => {
    const extra = { ...s("x", "CONFIRMED", "2026-09-01"), bookingType: "SINGLE_SESSION" };
    expect(endableSessions([...sessions, extra]).map((x) => x.id)).not.toContain("x");
  });

  test("a course with nothing left to cancel ends cleanly, removing 0", () => {
    expect(endableSessions([s("a", "ATTENDED", "2026-08-03")])).toEqual([]);
  });
});

describe("R4.6 — the reasons are a closed, queryable set", () => {
  test("exactly the three, and nothing else is accepted", () => {
    expect([...END_REASONS]).toEqual(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR"]);
    for (const r of END_REASONS) expect(isEndReason(r)).toBe(true);
    for (const bad of ["", "admin_error", "OTHER", null, undefined, 42, {}]) {
      expect(isEndReason(bad)).toBe(false);
    }
  });

  test("🔑 ADMIN_ERROR is one of them — that is what makes a mistaken sale findable later", () => {
    // The money follow-up is a human decision taken elsewhere; recording the reason is what lets someone ask
    // "which courses did we end because WE got it wrong?" with one query.
    expect(isEndReason("ADMIN_ERROR")).toBe(true);
  });
});

describe("the course summary shows the ending everywhere it appears", () => {
  test("🔴 an ended course reads ended on any screen that renders a summary", () => {
    // Otherwise staff keep booking into it from a screen that shows nothing wrong — the DTO is the only place
    // that can carry that fact to every one of them.
    const s = toCourseSummary({
      id: "c1",
      size: 10,
      usedSessions: 3,
      leaveUsed: 0,
      adminUnlocked: false,
      expiryDate: "2026-11-01",
      endedAt: new Date("2026-08-24T03:00:00.000Z"),
      endReason: "CUSTOMER_CANCELLED",
    });
    expect(s.endedAt).toBe("2026-08-24T03:00:00.000Z");
    expect(s.endReason).toBe("CUSTOMER_CANCELLED");
    expect(s.size).toBe(10); // the purchase is untouched — REQ-064's lesson
  });

  test("a live course reads null, and the rest of the summary is unchanged (regression)", () => {
    const s = toCourseSummary({
      id: "c1",
      size: 10,
      usedSessions: 3,
      leaveUsed: 1,
      adminUnlocked: false,
      expiryDate: "2026-11-01",
    });
    expect(s.endedAt).toBeNull();
    expect(s.endReason).toBeNull();
    expect(s.leaveQuota).toBe(3);
    expect(s.leaveRemaining).toBe(2);
  });
});
