// TASK-130 (REQ-042) — the pure part of `line:adopt-menus`. The script's only other move is a read + one
// upsert; the selection is what decides whether the DB ends up with the RIGHT ids (and whether a gap is
// reported instead of a half map), so it's the part worth testing.
//
// 🔴 TASK-249 §4 — the map is what `publishRichMenus` creates, and `missing` is computed over every key of it: the
// script aborts on any gap. 🔻 TASK-468 (REQ-107) — that set is now THREE, one bilingual menu per ROLE
// (`unknown` · `customer` · `teacher`); the six per-language names left this map (they stay in `OUR_MENU_NAMES` for
// provenance). Every claim below is the one it always was — only the names moved.
import { describe, expect, test } from "bun:test";
import { readSrc } from "./read-src";
import { CUSTOMER_MENU, TEACHER_MENU, UNKNOWN_MENU } from "./line-rich-menu";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { selectMenuIds, NAME_TO_KEY } = await import("../../scripts/line-adopt-menus");
const RICH = readSrc(await Bun.file(new URL("./line-rich-menu.ts", import.meta.url)).text());

const menu = (richMenuId: string, name: string) => ({ richMenuId, name });
const ALL_THREE = [
  menu("rm-u", "smart-scheduler-unknown"),
  menu("rm-c", "smart-scheduler-customer"),
  menu("rm-t", "smart-scheduler-teacher"),
];

describe("line:adopt-menus selectMenuIds (TASK-130 · TASK-249 §4 · TASK-468)", () => {
  test("maps the three per-role names onto the MenuIds keys", () => {
    const { ids, missing } = selectMenuIds(ALL_THREE);
    expect(ids).toEqual({ unknown: "rm-u", customer: "rm-c", teacher: "rm-t" });
    expect(missing).toEqual([]);
  });

  test("duplicate names → the LAST occurrence wins, deterministically", () => {
    const list = [...ALL_THREE, menu("rm-u-2", "smart-scheduler-unknown"), menu("rm-c-2", "smart-scheduler-customer"), menu("rm-t-2", "smart-scheduler-teacher")];
    const { ids, missing } = selectMenuIds(list);
    expect(ids).toEqual({ unknown: "rm-u-2", customer: "rm-c-2", teacher: "rm-t-2" });
    expect(missing).toEqual([]);
    expect(selectMenuIds(list).ids).toEqual(ids); // re-run picks the same ids → adopt is idempotent
  });

  test("a missing name is reported (the script then stores nothing)", () => {
    const { ids, missing } = selectMenuIds([menu("rm-u", "smart-scheduler-unknown")]);
    expect(ids).toEqual({ unknown: "rm-u" });
    expect(missing).toEqual(["smart-scheduler-customer", "smart-scheduler-teacher"]);
  });

  test("🔴 an OA that still holds ONLY the old per-language menus reports all three, and stores NOTHING", () => {
    // 🔻 TASK-468 — the same guard TASK-249 needed for REQ-079: until the owner publishes the per-role set, every OA
    // looks like this. It is a correct report, not a broken command — and the runtime keeps working meanwhile through
    // `menuIdFor`'s legacy fallback.
    const old = [
      menu("rm-p-th", "smart-scheduler-parent-th"),
      menu("rm-t-th", "smart-scheduler-teacher-th"),
      menu("rm-u-th", "smart-scheduler-unknown-th"),
      menu("rm-k-th", "smart-scheduler-known-th"),
    ];
    const { ids, missing } = selectMenuIds(old);
    expect(ids).toEqual({});
    expect(missing).toEqual(["smart-scheduler-unknown", "smart-scheduler-customer", "smart-scheduler-teacher"]);
  });

  test("menus created outside our publish are ignored, and an empty OA reports all three", () => {
    const { ids, missing } = selectMenuIds([menu("rm-x", "made-in-oa-manager"), { richMenuId: "rm-y" }]);
    expect(ids).toEqual({});
    expect(missing).toHaveLength(3);
  });

  test("🔑 the map covers EVERY menu `publishRichMenus` creates — derived, not listed", () => {
    // It reads the publish function itself rather than a list somebody has to remember to update: adopt silently
    // missing a menu is how an id nobody stores becomes a menu nobody sees (the defect TASK-247 removed).
    const pub = RICH.slice(RICH.indexOf("export async function publishRichMenus"));
    const created = [...pub.slice(0, pub.indexOf("\n}\n")).matchAll(/createRichMenu\(([A-Z_]+)\)/g)].map((m) => m[1]!);
    expect(created).toHaveLength(3);
    const nameOf: Record<string, string> = { UNKNOWN_MENU: UNKNOWN_MENU.name, CUSTOMER_MENU: CUSTOMER_MENU.name, TEACHER_MENU: TEACHER_MENU.name };
    for (const ident of created) {
      expect(nameOf[ident]).toBeDefined();
      expect(Object.keys(NAME_TO_KEY)).toContain(nameOf[ident]!);
    }
  });
});
