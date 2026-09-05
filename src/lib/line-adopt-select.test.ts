// TASK-130 (REQ-042) — the pure part of `line:adopt-menus`. The script's only other move is a read + one
// upsert; the selection is what decides whether the DB ends up with the RIGHT ids (and whether a gap is
// reported instead of a half map), so it's the part worth testing.
//
// 🔴 TASK-249 §4 — **six** canonical names now, not four. The two REQ-079 menus could only join `NAME_TO_KEY`
// after the owner published them (2026-09-05): `missing` is computed over every key of that map and the script
// aborts on any gap, so adding them earlier would have broken `line:adopt-menus` on every OA not yet
// re-published. The last test here is the guard that the next menu added cannot forget the map.
import { describe, expect, test } from "bun:test";
import { readSrc } from "./read-src";
import {
  KNOWN_RICH_MENU,
  PARENT_RICH_MENU,
  PARENT_RICH_MENU_EN,
  TEACHER_RICH_MENU,
  TEACHER_RICH_MENU_EN,
  UNKNOWN_RICH_MENU,
} from "./line-rich-menu";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { selectMenuIds, NAME_TO_KEY } = await import("../../scripts/line-adopt-menus");
const RICH = readSrc(await Bun.file(new URL("./line-rich-menu.ts", import.meta.url)).text());

const menu = (richMenuId: string, name: string) => ({ richMenuId, name });
const ALL_SIX = [
  menu("rm-p-th", "smart-scheduler-parent-th"),
  menu("rm-p-en", "smart-scheduler-parent-en"),
  menu("rm-t-th", "smart-scheduler-teacher-th"),
  menu("rm-t-en", "smart-scheduler-teacher-en"),
  menu("rm-u-th", "smart-scheduler-unknown-th"),
  menu("rm-k-th", "smart-scheduler-known-th"),
];

describe("line:adopt-menus selectMenuIds (TASK-130 · TASK-249 §4)", () => {
  test("maps the six canonical names onto the MenuIds keys", () => {
    const { ids, missing } = selectMenuIds(ALL_SIX);
    expect(ids).toEqual({
      parentTH: "rm-p-th",
      parentEN: "rm-p-en",
      teacherTH: "rm-t-th",
      teacherEN: "rm-t-en",
      unknownTH: "rm-u-th",
      knownTH: "rm-k-th",
    });
    expect(missing).toEqual([]);
  });

  test("duplicate names (this OA has 2 of each) → the LAST occurrence wins, deterministically", () => {
    const list = [
      ...ALL_SIX,
      menu("rm-p-th-2", "smart-scheduler-parent-th"),
      menu("rm-p-en-2", "smart-scheduler-parent-en"),
      menu("rm-t-th-2", "smart-scheduler-teacher-th"),
      menu("rm-t-en-2", "smart-scheduler-teacher-en"),
      menu("rm-u-th-2", "smart-scheduler-unknown-th"),
      menu("rm-k-th-2", "smart-scheduler-known-th"),
    ];
    const { ids, missing } = selectMenuIds(list);
    expect(ids).toEqual({
      parentTH: "rm-p-th-2",
      parentEN: "rm-p-en-2",
      teacherTH: "rm-t-th-2",
      teacherEN: "rm-t-en-2",
      unknownTH: "rm-u-th-2",
      knownTH: "rm-k-th-2",
    });
    expect(missing).toEqual([]);
    expect(selectMenuIds(list).ids).toEqual(ids); // re-run picks the same ids → adopt is idempotent
  });

  test("a missing name is reported (the script then stores nothing)", () => {
    const { ids, missing } = selectMenuIds([
      menu("rm-p-th", "smart-scheduler-parent-th"),
      menu("rm-t-th", "smart-scheduler-teacher-th"),
    ]);
    expect(ids).toEqual({ parentTH: "rm-p-th", teacherTH: "rm-t-th" });
    expect(missing).toEqual([
      "smart-scheduler-parent-en",
      "smart-scheduler-teacher-en",
      "smart-scheduler-unknown-th",
      "smart-scheduler-known-th",
    ]);
  });

  test("🔴 an OA that predates the REQ-079 publish reports the two, and stores NOTHING", () => {
    // The exact reason this map could not be extended in TASK-247: before the owner published, every OA looked
    // like this — and adopt aborts on any gap. Now it is a correct report instead of a broken command.
    const { missing } = selectMenuIds(ALL_SIX.slice(0, 4));
    expect(missing).toEqual(["smart-scheduler-unknown-th", "smart-scheduler-known-th"]);
  });

  test("menus created outside our publish are ignored, and an empty OA reports all six", () => {
    const { ids, missing } = selectMenuIds([menu("rm-x", "made-in-oa-manager"), { richMenuId: "rm-y" }]);
    expect(ids).toEqual({});
    expect(missing).toHaveLength(6);
  });

  test("🔑 the map covers EVERY menu `publishRichMenus` creates — derived, not listed", () => {
    // The guard @Sober asked for. It reads the publish function itself rather than a list somebody has to
    // remember to update: adopt silently missing a menu is how an id nobody stores becomes a menu nobody sees,
    // which is the defect TASK-247 had just finished removing.
    const pub = RICH.slice(RICH.indexOf("export async function publishRichMenus"));
    const created = [...pub.slice(0, pub.indexOf("\n}\n")).matchAll(/createRichMenu\(([A-Z_]+)\)/g)].map((m) => m[1]!);
    expect(created).toHaveLength(6);
    const nameOf: Record<string, string> = {
      PARENT_RICH_MENU: PARENT_RICH_MENU.name,
      PARENT_RICH_MENU_EN: PARENT_RICH_MENU_EN.name,
      TEACHER_RICH_MENU: TEACHER_RICH_MENU.name,
      TEACHER_RICH_MENU_EN: TEACHER_RICH_MENU_EN.name,
      UNKNOWN_RICH_MENU: UNKNOWN_RICH_MENU.name,
      KNOWN_RICH_MENU: KNOWN_RICH_MENU.name,
    };
    for (const ident of created) {
      expect(nameOf[ident]).toBeDefined();
      expect(Object.keys(NAME_TO_KEY)).toContain(nameOf[ident]!);
    }
  });
});
