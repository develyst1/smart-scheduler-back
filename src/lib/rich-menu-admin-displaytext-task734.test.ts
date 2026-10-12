// 🔻 TASK-734 (option A; Khwan's Q7: pressing a rich-menu button leaves no message, so the OA chat list does not bump the chat and the admin cannot find it) —
// the «คุยกับแอดมิน» cell now carries `displayText`, which LINE shows in the chat as the user's own message, so the chat surfaces for the admin.
// The postback DATA is unchanged (`action=admin`), so the webhook path is untouched. Every other cell is untouched. Ships only if the owner's phone SEES the bump on sid.
import { describe, expect, test } from "bun:test";
import { ALL_MENU_DEFS, CUSTOMER_MENU, KNOWN_RICH_MENU, KNOWN_RICH_MENU_EN, UNKNOWN_MENU, UNKNOWN_RICH_MENU, UNKNOWN_RICH_MENU_EN, type RichMenuArea } from "./line-rich-menu";

const postbacks = (areas: readonly any[]): RichMenuArea[] => areas.filter((a) => a.action?.type === "postback");
const ADMIN_TEXT = "คุยกับแอดมิน";

describe("🔴 TASK-734 — the admin cell carries displayText; nothing else does", () => {
  test("the unknown and the known (customer) menus: the `action=admin` cell is a postback with data `action=admin` AND displayText", () => {
    for (const menu of [UNKNOWN_RICH_MENU, UNKNOWN_RICH_MENU_EN, UNKNOWN_MENU, KNOWN_RICH_MENU, KNOWN_RICH_MENU_EN, CUSTOMER_MENU]) {
      const admin = menu.areas.filter((a) => a.action.data === "action=admin");
      expect(admin.length).toBe(1);
      expect(admin[0]!.action).toEqual({ type: "postback", data: "action=admin", displayText: ADMIN_TEXT });
    }
  });
  test("EVERY other postback cell in EVERY menu has NO displayText (only the admin cell shows a message)", () => {
    for (const def of ALL_MENU_DEFS) {
      for (const a of postbacks((def as any).areas)) {
        if (a.action.data === "action=admin") continue;
        expect({ name: def.name, data: a.action.data, displayText: a.action.displayText }).toEqual({ name: def.name, data: a.action.data, displayText: undefined });
      }
    }
  });
  test("the DATA of every cell is what the webhook reads: unchanged lists, in order", () => {
    expect(UNKNOWN_MENU.areas.map((a) => a.action.data)).toEqual(["action=enter", "action=admin"]);
    expect(CUSTOMER_MENU.areas.map((a) => a.action.data)).toEqual(["action=leave", "action=checkin", "action=mycourses", "action=register", "action=lang", "action=admin"]);
  });
  test("the cell geometry is unchanged (displayText is the only addition): the admin cell's bounds are the last cell's, as before", () => {
    expect(UNKNOWN_MENU.areas[1]!.bounds).toEqual({ x: 1250, y: 0, width: 1250, height: 843 });
    const last = CUSTOMER_MENU.areas.at(-1)!;
    expect(last.bounds.x).toBe(Math.floor(2500 / 3) * 2);
  });
});
