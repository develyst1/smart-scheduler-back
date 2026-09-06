// TASK-252 — a menu is OURS by its NAME, not by a row in our database.
//
// 🔴 The defect this closes is an INVERSION, which is why it went unnoticed: `line:remove-menus` protects
// anything not in `getMenuIds()`, and `line:remove-menus` clears `getMenuIds()` as its last act. After one run
// our own menus become indistinguishable from the customer's, and the rule written to protect THEIR menus
// protects OUR litter instead — and refuses to clean it. @Porter had already watched the same inference in
// `line-inspect-menus` label 20 menus we created ourselves as foreign on the demo OA.
//
// ⚠️ So the assertions here are mostly about the EMPTY-ids case. A test suite with ids stored — which is every
// test this repo had — cannot see the bug at all: that is exactly the state in which the old code was right.
import { describe, expect, test } from "bun:test";
import { readSrc } from "./read-src";
import * as rich from "./line-rich-menu";
import {
  ALL_MENU_DEFS,
  NAME_TO_KEY,
  OUR_MENU_NAMES,
  ourMenuMatch,
  summariseOurMenus,
  type MenuIds,
  type RichMenuDef,
} from "./line-rich-menu";
import { formatRemovalPlan, planMenuRemoval } from "./line-menu-removal-plan";

const RICH = readSrc(await Bun.file(new URL("./line-rich-menu.ts", import.meta.url)).text());
const PLAN = readSrc(await Bun.file(new URL("./line-menu-removal-plan.ts", import.meta.url)).text());
const INSPECT = readSrc(await Bun.file(new URL("../../scripts/line-inspect-menus.ts", import.meta.url)).text());
const ADOPT = readSrc(await Bun.file(new URL("../../scripts/line-adopt-menus.ts", import.meta.url)).text());
const PUBLISH = readSrc(await Bun.file(new URL("../../scripts/line-publish-menus.ts", import.meta.url)).text());
const REMOVE = readSrc(await Bun.file(new URL("../../scripts/line-remove-menus.ts", import.meta.url)).text());

/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const STORED: MenuIds = { unknownTH: "rm-u-th", knownTH: "rm-k-th" };

describe("TASK-252 — the registry is DERIVED, never retyped", () => {
  test("🔑 every RichMenuDef this module exports is in OUR_MENU_NAMES — read from the exports themselves", () => {
    // The completeness check that cannot go stale: a ninth menu joins by EXISTING. A hand-written list here
    // would need the same person who forgot `ALL_MENU_DEFS` to also remember this file.
    const exported = Object.entries(rich).filter(
      ([, v]) => !!v && typeof v === "object" && typeof (v as RichMenuDef).name === "string" && "chatBarText" in (v as object),
    ) as Array<[string, RichMenuDef]>;
    expect(exported.length).toBeGreaterThanOrEqual(8);
    for (const [ident, def] of exported) {
      expect({ ident, known: OUR_MENU_NAMES.has(def.name) }).toEqual({ ident, known: true });
    }
    expect(OUR_MENU_NAMES.size).toBe(ALL_MENU_DEFS.length);
  });

  test("every name is spelled by a definition, not by a literal in the registry", () => {
    // `ALL_MENU_DEFS` / `NAME_TO_KEY` must be built from the defs. A retyped string is a second source of truth
    // that agrees today and drifts on the first rename.
    const c = code(RICH);
    const registry = c.slice(c.indexOf("export const ALL_MENU_DEFS"), c.indexOf("export interface ChannelMenuRef"));
    expect(registry).not.toMatch(/"smart-scheduler-/);
    expect(registry).toContain("[PARENT_RICH_MENU.name]:");
    expect(registry).toContain("ALL_MENU_DEFS.map((m) => m.name)");
  });

  test("🔑 NAME_TO_KEY is SIX and OUR_MENU_NAMES is EIGHT — two questions, two answers", () => {
    // The task's Question. `adopt` asks "which names must be PRESENT for a complete map?" and `selectMenuIds`
    // aborts on any gap, so a name we define but never publish must stay OUT of it. Ownership asks "did WE name
    // this?" — and a menu called `smart-scheduler-unknown-en` on a channel is unambiguously ours whether or not
    // we ever published one.
    expect(Object.keys(NAME_TO_KEY)).toHaveLength(6);
    expect(OUR_MENU_NAMES.size).toBe(8);
    for (const name of Object.keys(NAME_TO_KEY)) expect(OUR_MENU_NAMES.has(name)).toBe(true);
    // The two that differ, named so the difference is deliberate rather than an oversight someone "fixes".
    expect(OUR_MENU_NAMES.has("smart-scheduler-unknown-en")).toBe(true);
    expect(OUR_MENU_NAMES.has("smart-scheduler-known-en")).toBe(true);
    expect(NAME_TO_KEY["smart-scheduler-unknown-en"]).toBeUndefined();
    expect(NAME_TO_KEY["smart-scheduler-known-en"]).toBeUndefined();
  });

  test("a defined-but-unpublished name still gets a readable label", () => {
    const m = ourMenuMatch({ richMenuId: "x", name: "smart-scheduler-unknown-en" }, {});
    expect(m).toEqual({ label: "unknown-en", matchedBy: "name" });
  });
});

describe("TASK-252 — ourMenuMatch is the single predicate", () => {
  test("a stored id wins, and says so", () => {
    expect(ourMenuMatch({ richMenuId: "rm-u-th", name: "anything-at-all" }, STORED)).toEqual({
      label: "unknownTH",
      matchedBy: "id",
    });
  });

  test("🔴 our name with NO stored ids at all — the state remove-menus leaves behind", () => {
    expect(ourMenuMatch({ richMenuId: "rm-old", name: "smart-scheduler-known-th" }, {})).toEqual({
      label: "knownTH",
      matchedBy: "name",
    });
  });

  test("a name we never chose is not ours, and neither is a missing one", () => {
    expect(ourMenuMatch({ richMenuId: "rm-promo", name: "promo-2026" }, STORED)).toBeNull();
    expect(ourMenuMatch({ richMenuId: "rm-x" }, STORED)).toBeNull();
    expect(ourMenuMatch({ richMenuId: "rm-x", name: null }, STORED)).toBeNull();
    // ⚠️ Not a prefix match: a name that merely starts like ours is someone else's.
    expect(ourMenuMatch({ richMenuId: "rm-x", name: "smart-scheduler-parent-th-copy" }, STORED)).toBeNull();
    expect(ourMenuMatch({ richMenuId: "rm-x", name: "" }, STORED)).toBeNull();
  });

  test("an empty stored id never claims a menu that has none", () => {
    // `{ parentTH: undefined }` and `{ parentTH: "" }` must not match a channel row with no id — that would
    // make every unnamed foreign menu ours.
    expect(ourMenuMatch({ name: "promo" }, { parentTH: undefined })).toBeNull();
    expect(ourMenuMatch({ richMenuId: "", name: "promo" }, { parentTH: "" } as MenuIds)).toBeNull();
  });
});

describe("TASK-252 — both readers use it, and neither keeps a copy", () => {
  test("🚫 line-inspect-menus no longer infers ownership from the stored ids", () => {
    const c = code(INSPECT);
    expect(c).toContain("ourMenuMatch(m, ids)");
    // The exact inference @Porter saw misfire on 20 of our own menus.
    expect(c).not.toContain("entries.some(([, id]) => id === m.richMenuId)");
    // …and it holds no name list of its own.
    expect(c).not.toMatch(/"smart-scheduler-/);
  });

  test("🚫 the removal plan holds no name list and no second ownership test", () => {
    const c = code(PLAN);
    expect(c).toContain("ourMenuMatch(m, stored)");
    expect(c).not.toMatch(/"smart-scheduler-/);
    expect(c).not.toContain("OUR_MENU_NAMES.has");
    // It shares the library's row shape rather than declaring a second identical one.
    expect(c).toContain("export type ChannelMenu = ChannelMenuRef;");
  });

  test("🚫 line-adopt-menus re-exports the registry instead of declaring one", () => {
    const c = code(ADOPT);
    expect(c).toContain("export { NAME_TO_KEY };");
    expect(c).not.toContain("export const NAME_TO_KEY");
    expect(c).not.toMatch(/"smart-scheduler-/);
    // And it still works off that same registry — `selectMenuIds` is unchanged and reads `NAME_TO_KEY`.
    expect(c).toContain("NAME_TO_KEY[m.name]");
  });
});

describe("TASK-252 §4 — publish REPORTS the litter, and never deletes it", () => {
  const created: MenuIds = { unknownTH: "rm-u-2", knownTH: "rm-k-2" };
  const channel = [
    { richMenuId: "rm-u-1", name: "smart-scheduler-unknown-th" },
    { richMenuId: "rm-k-1", name: "smart-scheduler-known-th" },
    { richMenuId: "rm-u-2", name: "smart-scheduler-unknown-th" },
    { richMenuId: "rm-k-2", name: "smart-scheduler-known-th" },
    { richMenuId: "rm-promo", name: "promo-2026" },
  ];

  test("it counts ours vs the set just published", () => {
    expect(summariseOurMenus(channel, created)).toEqual({ onChannel: 5, ours: 4, current: 2, leftover: 2 });
  });

  test("nothing of ours on an empty channel is zero, not a crash", () => {
    expect(summariseOurMenus([], {})).toEqual({ onChannel: 0, ours: 0, current: 0, leftover: 0 });
  });

  test("🚫 publish still deletes nothing — it prints", () => {
    const c = code(PUBLISH);
    expect(c).toContain("formatPublishFootprint(await listRichMenus(), ids)");
    for (const forbidden of ["deleteRichMenu", "clearMenuIds", "clearDefaultRichMenu"]) {
      expect(c).not.toContain(forbidden);
    }
  });
});

describe("TASK-252 §5 — the limit, and why a name match is allowed at all", () => {
  test("🔴 a name match is never silent — the plan prints WHICH test claimed each row", () => {
    // This is the whole safety argument: the predicate makes a CANDIDATE, a human makes the decision. If the
    // plan printed an id match and a name match identically, the reviewer could not apply that judgement and
    // §5's reasoning would be resting on nothing.
    const plan = planMenuRemoval({}, [{ richMenuId: "rm-1", name: "smart-scheduler-parent-th" }], null);
    expect(plan.toDelete[0]!.matchedBy).toBe("name");
    const out = formatRemovalPlan(plan, { apply: false, account: "acc" });
    expect(out).toContain("[OUR NAME (not in the stored ids)]");
    expect(out).toContain("a convention we chose, not proof");
  });

  test("🚫 the predicate is not used anywhere that acts without review", () => {
    // `--apply` still requires the typed `REMOVE <n>` phrase, and the count comes from the printed plan.
    const c = code(REMOVE);
    expect(c).toContain("confirmationPhrase(plan.toDelete.length)");
    expect(c).toContain("if (typed?.trim() !== expected)");
    // The script itself does not decide ownership; the pure planner does.
    expect(c).not.toContain("ourMenuMatch");
    expect(c).not.toMatch(/"smart-scheduler-/);
  });
});
