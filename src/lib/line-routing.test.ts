import { describe, expect, test } from "bun:test";
import { decideMessageRoute, otherRosterTable } from "./line-routing";

describe("decideMessageRoute — conversation beats already-linked routing (TASK-046)", () => {
  test("🐛 THE REPRO: an already-linked user mid-`สมัคร` reaches the LINKING branch, not the parent menu", () => {
    // Before the fix, `linked === "customer"` won and swallowed the "2" (teacher) reply.
    expect(decideMessageRoute("CHOOSE_ROLE", "customer")).toBe("linking");
    expect(decideMessageRoute("AWAIT_CODE", "customer")).toBe("linking");
    // ...and the same for an already-linked teacher or admin changing role.
    expect(decideMessageRoute("CHOOSE_ROLE", "teacher")).toBe("linking");
    expect(decideMessageRoute("AWAIT_CODE", "admin")).toBe("linking");
  });

  test("a linked user with NO active linking session still gets normal routing (unchanged)", () => {
    expect(decideMessageRoute(undefined, "customer")).toBe("linked");
    expect(decideMessageRoute(null, "teacher")).toBe("linked");
    expect(decideMessageRoute(undefined, "admin")).toBe("linked");
  });

  test("adding a student still wins over everything (the pre-existing rule this fix follows)", () => {
    expect(decideMessageRoute("AWAIT_STUDENT_NAME", "customer")).toBe("add-student");
    expect(decideMessageRoute("AWAIT_STUDENT_NAME", null)).toBe("add-student");
  });

  test("an unlinked user with no session gets the welcome", () => {
    expect(decideMessageRoute(undefined, null)).toBe("welcome");
    expect(decideMessageRoute(null, undefined)).toBe("welcome");
  });

  test("an unlinked user mid-linking still routes to linking", () => {
    expect(decideMessageRoute("CHOOSE_ROLE", null)).toBe("linking");
    expect(decideMessageRoute("AWAIT_CODE", null)).toBe("linking");
  });
});

describe("otherRosterTable — role change MOVES the link (TASK-046)", () => {
  test("linking as teacher clears the parent link, and vice-versa", () => {
    expect(otherRosterTable("teacher")).toBe("parents");
    expect(otherRosterTable("customer")).toBe("teachers");
  });
});
