import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { PARENT_RICH_MENU, TEACHER_RICH_MENU } = await import("./line-rich-menu");

describe("rich-menu definitions (REQ-015 / TASK-038)", () => {
  test("parent menu = 6 postback areas, in order, with NO qr button", () => {
    expect(PARENT_RICH_MENU.areas).toHaveLength(6);
    const actions = PARENT_RICH_MENU.areas.map((a) => a.action.data);
    expect(actions).toEqual([
      "action=checkin",
      "action=leave",
      "action=children",
      "action=register",
      "action=lang",
      "action=help",
    ]);
    expect(actions.some((d) => /qr/i.test(d))).toBe(false); // the confirmed scope decision
    for (const a of PARENT_RICH_MENU.areas) expect(a.action.type).toBe("postback");
  });

  test("teacher menu = my-schedule (REQ-016 slot) + language", () => {
    expect(TEACHER_RICH_MENU.areas.map((a) => a.action.data)).toEqual(["action=schedule", "action=lang"]);
  });

  test("menu image sizes are valid LINE dimensions", () => {
    expect(PARENT_RICH_MENU.size).toEqual({ width: 2500, height: 1686 });
    expect(TEACHER_RICH_MENU.size).toEqual({ width: 2500, height: 843 });
  });
});
