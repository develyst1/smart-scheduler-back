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

  test("🔴 TASK-231: an unlinked user with no session now gets SILENCE (this line read `welcome`)", () => {
    // 🔑 THE REGRESSION, and it is deliberately left in place rather than moved to a new file: this assertion
    // read `"welcome"` and PASSED, which is exactly the shipped behaviour REQ-079 §16 is about — the bot
    // replying to stray text in an idle chat while a human was about to. Editing this line is the proof that
    // behaviour changed; a new test beside an untouched old one would have proved nothing.
    expect(decideMessageRoute(undefined, null)).toBe("silence");
    expect(decideMessageRoute(null, undefined)).toBe("silence");
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
