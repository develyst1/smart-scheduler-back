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

describe("🔴 AC-B6 — the four counts sum to the total, with nothing in two categories", () => {
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
    expect(buckets.map((b) => b.length)).toEqual([2, 2, 2, 2]);
  });

  test("every status is reported even at zero — a chip that vanishes reads as a missing feature", () => {
    expect(countByStatus([], TODAY)).toEqual({ CANCELLED: 0, COMPLETED: 0, EXPIRED: 0, ACTIVE: 0 });
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
