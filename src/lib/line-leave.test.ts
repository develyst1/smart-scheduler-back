// TASK-135 (SPEC-041 / REQ-046) — the decisions the LINE leave flow makes before it touches anything:
// does the parent get a "which child?" step (AC-3/AC-5), and does one option actually identify its session
// (AC-2). `updateBookingStatus` is untouched by this task, so nothing here asserts quota/extension.
import { describe, expect, test } from "bun:test";
import { childrenWithSessions, leaveSessionLabel, needsChildStep, type LeaveSession } from "./line-leave";

const session = (over: Partial<LeaveSession> & { id: string; studentId: string; startTime: string }): LeaveSession => ({
  student: { name: "น้องเอ" },
  teacher: { nickname: "ก้อง" },
  subject: { name: "Surfskate" },
  ...over,
});

const oneChildTwoSessions = [
  session({ id: "b1", studentId: "s1", startTime: "09:00:00" }),
  session({ id: "b2", studentId: "s1", startTime: "11:00:00", subject: { name: "Bike" } }),
];
const twoChildren = [
  session({ id: "b1", studentId: "s1", startTime: "09:00:00" }),
  session({ id: "b2", studentId: "s2", startTime: "10:00:00", student: { name: "น้องบี", nickname: "บี" } }),
];

describe("needsChildStep / childrenWithSessions (AC-3, AC-5)", () => {
  test("one child with two sessions → NO child step (stays one tap, then the session picker)", () => {
    expect(needsChildStep(oneChildTwoSessions)).toBe(false);
    expect(childrenWithSessions(oneChildTwoSessions)).toEqual([{ studentId: "s1", name: "น้องเอ" }]);
  });

  test("two children each with a session today → ask which child first", () => {
    expect(needsChildStep(twoChildren)).toBe(true);
    expect(childrenWithSessions(twoChildren)).toEqual([
      { studentId: "s1", name: "น้องเอ" },
      { studentId: "s2", name: "บี" }, // nickname preferred — it's what fits a 20-char button
    ]);
  });

  test("a single session → no child step (the common case is unchanged)", () => {
    expect(needsChildStep([oneChildTwoSessions[0]!])).toBe(false);
  });

  test("one entry per child even when a child has several sessions", () => {
    expect(childrenWithSessions([...oneChildTwoSessions, ...twoChildren])).toHaveLength(2);
  });
});

describe("leaveSessionLabel (AC-2)", () => {
  test("TH names time · teacher · program", () => {
    expect(leaveSessionLabel(oneChildTwoSessions[0]!, "TH")).toBe("09:00 · ครูก้อง · Surfskate");
  });

  test("EN drops the ครู prefix, same fields", () => {
    expect(leaveSessionLabel(oneChildTwoSessions[1]!, "EN")).toBe("11:00 · ก้อง · Bike");
  });

  test("a session with no teacher/subject row still renders (never a raw key or 'undefined')", () => {
    const bare = session({ id: "b9", studentId: "s9", startTime: "15:00:00", teacher: null, subject: null });
    expect(leaveSessionLabel(bare, "TH")).toBe("15:00 · ครู- · -");
  });
});
