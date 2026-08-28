import { describe, expect, test } from "bun:test";
import { COURSE_STATUSES, countByStatus, courseStatus, type CourseStatusInput } from "./course-status";
import { toCourseSummary } from "./leave";

// SPEC-064 / TASK-188 (REQ-036 B3). The precedence IS the design: it is what makes every course exactly one
// status, which is what makes AC-B6 (the four counts sum to the total) true by construction rather than by
// luck. These tests are written against the cases where two statuses could both look true.
const TODAY = "2026-08-25";
const c = (o: Partial<CourseStatusInput> = {}): CourseStatusInput => ({
  size: 10,
  usedSessions: 3,
  expiryDate: "2026-11-01",
  // Explicit nulls, because TASK-205 made both REQUIRED: a fixture that can omit a lifecycle flag is a fixture
  // that can silently stop testing the status that flag decides.
  endedAt: null,
  droppedAt: null,
  ...o,
});

describe("courseStatus precedence (TASK-188)", () => {
  test("a live, part-used course is ACTIVE", () => {
    expect(courseStatus(c(), TODAY)).toBe("ACTIVE");
  });

  test("🔴 CANCELLED wins over everything — that is the badge bug this exists to kill", () => {
    // A cancelled course wore a green ปกติ because the badge computed its own idea of "over". Whatever else
    // is true of the row, an ended course reads CANCELLED.
    expect(courseStatus(c({ endedAt: new Date() }), TODAY)).toBe("CANCELLED");
    expect(courseStatus(c({ endedAt: "2026-08-24T10:00:00Z", usedSessions: 10 }), TODAY)).toBe("CANCELLED");
    expect(courseStatus(c({ endedAt: new Date(), expiryDate: "2026-01-01" }), TODAY)).toBe("CANCELLED");
  });

  test("🔴 COMPLETED beats EXPIRED — the owner's call, and the interesting one", () => {
    // A family that used all 10 has no problem worth flagging, even months after the expiry date.
    expect(courseStatus(c({ usedSessions: 10, expiryDate: "2026-01-01" }), TODAY)).toBe("COMPLETED");
    // …but sessions left after expiry is a family that PAID FOR CLASSES THEY NEVER RECEIVED. It is the one
    // status that costs the customer money, and a binary active/inactive would have hidden it.
    expect(courseStatus(c({ usedSessions: 7, expiryDate: "2026-01-01" }), TODAY)).toBe("EXPIRED");
  });

  test("over-used counts as COMPLETED (an extra delivered session must not read as unfinished)", () => {
    expect(courseStatus(c({ usedSessions: 11 }), TODAY)).toBe("COMPLETED");
  });

  test("expiry is inclusive of the day itself — a course expiring TODAY is still ACTIVE", () => {
    expect(courseStatus(c({ expiryDate: TODAY }), TODAY)).toBe("ACTIVE");
    expect(courseStatus(c({ expiryDate: "2026-08-24" }), TODAY)).toBe("EXPIRED");
  });

  test("`endedAt` is tested for presence, not truthiness", () => {
    expect(courseStatus(c({ endedAt: null }), TODAY)).toBe("ACTIVE");
    expect(courseStatus(c({ endedAt: undefined }), TODAY)).toBe("ACTIVE");
  });
});

describe("🔴 AC-B6 — the counts sum to the total, with nothing in two categories", () => {
  const mixed: CourseStatusInput[] = [
    c(),
    c({ usedSessions: 0 }),
    c({ endedAt: new Date() }),
    c({ endedAt: new Date(), usedSessions: 10, expiryDate: "2026-01-01" }), // ambiguous on purpose
    c({ usedSessions: 10 }),
    c({ usedSessions: 10, expiryDate: "2026-01-01" }), // completed AND past expiry
    c({ usedSessions: 2, expiryDate: "2026-01-01" }),
    c({ usedSessions: 9, expiryDate: "2026-08-24" }),
  ];

  test("every course lands in exactly one bucket", () => {
    const counts = countByStatus(mixed, TODAY);
    const sum = COURSE_STATUSES.reduce((n, s) => n + counts[s], 0);
    expect(sum).toBe(mixed.length);
  });

  test("filtering by each status partitions the set — no overlap, nothing missing", () => {
    const buckets = COURSE_STATUSES.map((s) => mixed.filter((x) => courseStatus(x, TODAY) === s));
    expect(buckets.flat()).toHaveLength(mixed.length); // nothing counted twice, nothing dropped
    expect(buckets.map((b) => b.length)).toEqual([2, 0, 2, 2, 2]); // DROPPED is 0 in this fixture — see below
  });

  test("every status is reported even at zero — a chip that vanishes reads as a missing feature", () => {
    expect(countByStatus([], TODAY)).toEqual({ CANCELLED: 0, DROPPED: 0, COMPLETED: 0, EXPIRED: 0, ACTIVE: 0 });
  });
});

describe("the status reaches the DTO from the one builder", () => {
  const base = {
    id: "c1",
    size: 10,
    usedSessions: 3,
    leaveUsed: 0,
    adminUnlocked: false,
    expiryDate: "2026-11-01",
  };

  test("🔴 the cancelled course does NOT read ACTIVE — the whole point, at the seam that renders it", () => {
    expect(toCourseSummary({ ...base, endedAt: new Date() }, TODAY).status).toBe("CANCELLED");
    expect(toCourseSummary(base, TODAY).status).toBe("ACTIVE");
  });

  test("lifecycle status is orthogonal to the leave lock — a locked course is still ACTIVE", () => {
    // Folding one into the other would make "can this family take another leave?" and "is this course over?"
    // the same question, and they are not.
    const locked = toCourseSummary({ ...base, leaveUsed: 3 }, TODAY);
    expect(locked.leaveLocked).toBe(true);
    expect(locked.status).toBe("ACTIVE");
  });
});

// ═══ SPEC-065 / TASK-198 — DROPPED joins the precedence ═══
describe("DROPPED — a paused course (TASK-198)", () => {
  test("a paused course reads DROPPED", () => {
    expect(courseStatus(c({ droppedAt: new Date() }), TODAY)).toBe("DROPPED");
  });

  test("🔴 dropped BEATS expired — a course paused past its own window is paused, not expired", () => {
    // This is the case the precedence exists for. Telling the owner "EXPIRED" about a course he paused himself
    // sends him to fix something that is working exactly as designed.
    expect(courseStatus(c({ droppedAt: new Date(), expiryDate: "2026-01-01" }), TODAY)).toBe("DROPPED");
  });

  test("dropped beats completed too — the count says nothing about whether they are coming back", () => {
    expect(courseStatus(c({ droppedAt: new Date(), usedSessions: 10 }), TODAY)).toBe("DROPPED");
  });

  test("🔴 CANCELLED still beats DROPPED — ending is terminal, pausing is not", () => {
    // A course that was paused and then ended is ended. The reverse ordering would show a cancelled course as
    // merely paused and offer a resume button that cannot work.
    expect(courseStatus(c({ droppedAt: new Date(), endedAt: new Date() }), TODAY)).toBe("CANCELLED");
  });

  test("clearing `droppedAt` returns the course to whatever it otherwise is — resume is not a status", () => {
    expect(courseStatus(c({ droppedAt: null }), TODAY)).toBe("ACTIVE");
    expect(courseStatus(c({ droppedAt: null, expiryDate: "2026-01-01" }), TODAY)).toBe("EXPIRED");
  });

  test("🔴 AC-B6 still holds with five statuses — every course lands in exactly one", () => {
    const five: CourseStatusInput[] = [
      c({}),
      c({ endedAt: new Date() }),
      c({ droppedAt: new Date() }),
      c({ droppedAt: new Date(), expiryDate: "2026-01-01" }), // ambiguous on purpose
      c({ usedSessions: 10 }),
      c({ usedSessions: 2, expiryDate: "2026-01-01" }),
    ];
    const counts = countByStatus(five, TODAY);
    expect(COURSE_STATUSES.reduce((n, s) => n + counts[s], 0)).toBe(five.length);
    expect(counts.DROPPED).toBe(2);
    const buckets = COURSE_STATUSES.map((s) => five.filter((x) => courseStatus(x, TODAY) === s));
    expect(buckets.flat()).toHaveLength(five.length);
  });

  test("the five filter chips come for free — `countByStatus` reports DROPPED at zero too", () => {
    expect(countByStatus([c({})], TODAY).DROPPED).toBe(0);
  });
});

// ═══ 🔴 TASK-205 — the COUNT, not the rule ═══
//
// The bug this closes: every row's own `status` said DROPPED while the chip counting them said 0, because the
// caller hand-copied four fields into `countByStatus` and TASK-198's `droppedAt` was never added to the list.
// The rule was right; the number the owner reads was wrong. So these tests assert the two agreeing — which is
// the check that was missing, in the review and in the suite.
describe("🔴 the status and the count can never disagree (TASK-205)", () => {
  const rows: CourseStatusInput[] = [
    c({}),
    c({ droppedAt: new Date() }),
    c({ droppedAt: new Date(), expiryDate: "2026-01-01" }),
    c({ endedAt: new Date() }),
    c({ usedSessions: 10 }),
  ];

  test("a dropped course is COUNTED as dropped, not merely labelled dropped", () => {
    expect(countByStatus(rows, TODAY).DROPPED).toBe(2);
  });

  test("🔑 every bucket equals the rows that claim that status — the invariant, stated once", () => {
    // If a future caller projects away a lifecycle field again, this fails: the labels and the counts stop
    // matching. That is the assertion the DROPPED chip needed and did not have.
    const counts = countByStatus(rows, TODAY);
    for (const s of COURSE_STATUSES) {
      expect(counts[s]).toBe(rows.filter((r) => courseStatus(r, TODAY) === s).length);
    }
  });

  test("a lifecycle flag cannot be omitted from the input at all — it is required (the structural guard)", () => {
    // @ts-expect-error — `droppedAt` is REQUIRED; omitting it is a compile error, which is the whole point of
    // TASK-205. If this line ever stops erroring, the guard has been weakened and the bug can return.
    const lossy: CourseStatusInput = { size: 10, usedSessions: 3, expiryDate: "2026-11-01", endedAt: null };
    expect(lossy).toBeDefined();
  });
});
