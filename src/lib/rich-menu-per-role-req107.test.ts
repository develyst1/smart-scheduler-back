// TASK-468 (REQ-107 §1) — ONE bilingual menu per ROLE, by value. The cells are the CUSTOMER'S, read off her own sheet
// (`project-docs/customer-2026-09-25-richmenu/`): the 6-cell and 2-cell images are today's cells in today's order at
// today's sizes, so the three definitions reuse the existing areas and change only the name, the chat bar and the id.
import { describe, expect, test } from "bun:test";
import {
  CUSTOMER_MENU,
  KNOWN_RICH_MENU,
  TEACHER_MENU,
  TEACHER_RICH_MENU,
  UNKNOWN_MENU,
  UNKNOWN_RICH_MENU,
  menuHasAdminButton,
  mergeMenuIds,
  type RichMenuDef,
} from "./line-rich-menu";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const actions = (m: RichMenuDef) => m.areas.map((a: any) => a.action.data);

describe("🔑 TASK-468 — the three per-role menus, by value", () => {
  test("UNLINKED (2 cells): สมัครสมาชิก / Sign Up · คุยกับแอดมิน / Chat with Admin — the account DEFAULT", () => {
    expect({ name: UNKNOWN_MENU.name, bar: UNKNOWN_MENU.chatBarText, size: UNKNOWN_MENU.size, selected: UNKNOWN_MENU.selected }).toEqual({
      name: "smart-scheduler-unknown", bar: "เมนู | Menu", size: { width: 2500, height: 843 }, selected: true,
    });
    expect(actions(UNKNOWN_MENU)).toEqual(["action=enter", "action=admin"]); // Sign Up is still `enter` — TASK-469 moves it
  });

  test("LINKED PARENT (6 cells), in the customer's order: Request Leave · Check In · My Course / Add Student · Language-Help · Chat with Admin", () => {
    expect({ name: CUSTOMER_MENU.name, bar: CUSTOMER_MENU.chatBarText, size: CUSTOMER_MENU.size }).toEqual({
      name: "smart-scheduler-customer", bar: "เมนู | Menu", size: { width: 2500, height: 1686 },
    });
    expect(actions(CUSTOMER_MENU)).toEqual(["action=leave", "action=checkin", "action=mycourses", "action=register", "action=lang", "action=admin"]);
  });

  test("TEACHER: the EXISTING cells and artwork, re-published — only the name and the chat bar change", () => {
    expect(TEACHER_MENU.areas).toEqual(TEACHER_RICH_MENU.areas);
    expect(TEACHER_MENU.size).toEqual(TEACHER_RICH_MENU.size);
    expect({ name: TEACHER_MENU.name, bar: TEACHER_MENU.chatBarText }).toEqual({ name: "smart-scheduler-teacher", bar: "เมนู | Menu" });
  });

  test("📌 the cells are REUSED, not restated — a second spelling of a layout is how two menus that 'should match' drift", () => {
    expect(UNKNOWN_MENU.areas).toBe(UNKNOWN_RICH_MENU.areas);
    expect(CUSTOMER_MENU.areas).toBe(KNOWN_RICH_MENU.areas);
    expect(TEACHER_MENU.areas).toBe(TEACHER_RICH_MENU.areas);
  });

  test("🔴 `คุยกับแอดมิน` is on both parent-facing menus — a person is always reachable (the unchanged REQ-079 rule)", () => {
    expect(menuHasAdminButton(UNKNOWN_MENU)).toBe(true);
    expect(menuHasAdminButton(CUSTOMER_MENU)).toBe(true);
  });

  test("the chat bar fits LINE's limit (14 characters) on all three", () => {
    for (const m of [UNKNOWN_MENU, CUSTOMER_MENU, TEACHER_MENU]) expect({ m: m.name, fits: [...m.chatBarText].length <= 14 }).toEqual({ m: m.name, fits: true });
  });
});

describe("🔑 TASK-468 — the MERGE keeps the old family through the new publish (TASK-247, unchanged)", () => {
  test("storing the three per-role ids leaves every old per-language id in place — the sweep needs them to recognise a follower", () => {
    const before = { parentTH: "p-th", parentEN: "p-en", teacherTH: "t-th", unknownTH: "u-th", knownTH: "k-th" };
    expect(mergeMenuIds(before, { unknown: "u", customer: "c", teacher: "t" })).toEqual({ ...before, unknown: "u", customer: "c", teacher: "t" });
  });
});
