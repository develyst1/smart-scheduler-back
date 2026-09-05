// TASK-247 (REQ-079 §12) — the artwork ↔ code contract, and the publish path that would never have created
// the two menus at all.
//
// 🔴 Why this file exists at all. The menus were "done" in TASK-234 and the owner still saw the old six-cell
// blue menu, because **`publishRichMenus` did not know they existed**: `linkKnownRichMenu` read `ids.knownTH`,
// nothing ever wrote it, and — best-effort by design — it did nothing, silently. **Supplying the images would
// have changed nothing and the run would still have printed ✓.** So the assertions here are mostly about the
// publish path; the artwork is the smaller half.
//
// The README has said *"never one side alone"* since TASK-041. A sentence is not a control: this reads the
// generator **as text** and fails if either side moves a cell.
import { describe, expect, test } from "bun:test";
import { readSrc } from "./read-src";
import {
  KNOWN_RICH_MENU,
  PARENT_RICH_MENU,
  TEACHER_RICH_MENU,
  UNKNOWN_RICH_MENU,
  menuHasAdminButton,
  mergeMenuIds,
  type MenuIds,
  type RichMenuDef,
} from "./line-rich-menu";

const SRC = readSrc(await Bun.file(new URL("./line-rich-menu.ts", import.meta.url)).text());
const GEN = readSrc(await Bun.file(new URL("../../assets/line/generate-rich-menus.mjs", import.meta.url)).text());
const PUBLISH = readSrc(await Bun.file(new URL("../../scripts/line-publish-menus.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const GENC = code(GEN);
const fn = (src: string, decl: string) => {
  const rest = src.slice(src.indexOf(decl));
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};

/**
 * The generator's cell rectangles, read out of its source.
 *
 * 📌 The two constants are taken from the GENERATOR too (`const KW = 833` / `const CH = 843`), not retyped here:
 * a third copy of the geometry inside the test would be one more thing to drift. Only arithmetic over those two
 * names is accepted — anything else fails loudly rather than being silently evaluated.
 */
const genConst = (name: string): number => {
  const m = GENC.match(new RegExp("const " + name + " = (\\d+)"));
  expect(m).not.toBeNull();
  return Number(m![1]);
};
const KW = genConst("KW");
const CH = genConst("CH");

function generatorCells(listName: string): Array<{ x: number; y: number; w: number; h: number; icon: string }> {
  const start = GENC.indexOf(`const ${listName} = (L) => [`);
  expect(start).toBeGreaterThan(-1);
  const body = GENC.slice(start, GENC.indexOf("];", start));
  const rows = [...body.matchAll(/\{ x: ([^,]+), y: ([^,]+), w: ([^,]+), h: ([^,]+), icon: "([a-z]+)"/g)];
  expect(rows.length).toBeGreaterThan(0);
  const num = (expr: string): number => {
    // Arithmetic over KW/CH and digits only — never a general eval of whatever the file happens to contain.
    expect(expr.trim()).toMatch(/^[\d\s+\-*/()]*(?:(?:KW|CH)[\d\s+\-*/()]*)*$/);
    return Function("KW", "CH", `return (${expr});`)(KW, CH) as number;
  };
  return rows.map((r) => ({ x: num(r[1]!), y: num(r[2]!), w: num(r[3]!), h: num(r[4]!), icon: r[5]! }));
}

const bounds = (m: RichMenuDef) => m.areas.map((a) => a.bounds);

describe("🔴 the artwork and the tap areas are ONE geometry — the README sentence, as a test", () => {
  test("`unknown-th.png`'s drawn cells are exactly `UNKNOWN_RICH_MENU`'s tap areas", () => {
    // A drawn cell that does not match its tap area is the worst kind of UI bug: the button looks right and
    // does something else, or nothing. Nobody reports it as a layout problem.
    const drawn = generatorCells("unknownCells").map(({ x, y, w, h }) => ({ x, y, width: w, height: h }));
    expect(drawn).toEqual(bounds(UNKNOWN_RICH_MENU));
  });

  test("`known-th.png`'s drawn cells are exactly `KNOWN_RICH_MENU`'s tap areas — all six", () => {
    const drawn = generatorCells("knownCells").map(({ x, y, w, h }) => ({ x, y, width: w, height: h }));
    expect(drawn).toEqual(bounds(KNOWN_RICH_MENU));
    expect(drawn).toHaveLength(6);
  });

  test("🔑 …and the guard is real: moving ONE side breaks it", () => {
    // Proof the assertion above is not vacuously true — the same comparison against a deliberately shifted
    // rectangle must fail. Without this, "the bounds match" could survive a regex that matched nothing.
    const drawn = generatorCells("knownCells").map(({ x, y, w, h }) => ({ x, y, width: w, height: h }));
    const moved = drawn.map((b, i) => (i === 4 ? { ...b, x: b.x + 1 } : b));
    expect(moved).not.toEqual(bounds(KNOWN_RICH_MENU));
  });

  test("the image sizes match the menu sizes", () => {
    expect(GENC).toContain('{ file: "unknown-th.png", svg: menuSvg({ width: 2500, height: 843');
    expect(GENC).toContain('{ file: "known-th.png", svg: menuSvg({ width: 2500, height: 1686');
    expect(UNKNOWN_RICH_MENU.size).toEqual({ width: 2500, height: 843 });
    expect(KNOWN_RICH_MENU.size).toEqual({ width: 2500, height: 1686 });
  });

  test("🚫 the four shipped REQ-015 images are NOT repainted", () => {
    // A repaint means re-creating those menus, which changes their ids — and every already-linked teacher keeps
    // the OLD menu until they re-link. An orange teacher menu is a migration, not a colour change (SA's §4).
    // Asserted at the only place the colour is chosen: the four old jobs pass no `accent`, so they stay BLUE.
    for (const job of ["parent-th.png", "parent-en.png", "teacher-th.png", "teacher-en.png"]) {
      const line = GENC.split("\n").find((l) => l.includes(`file: "${job}"`))!;
      expect(line).not.toContain("accent");
    }
    for (const job of ["unknown-th.png", "known-th.png"]) {
      const line = GENC.split("\n").find((l) => l.includes(`file: "${job}"`))!;
      expect(line).toContain("accent: ORANGE");
    }
    expect(GENC).toContain('const BLUE = "#228be6"');
    expect(GENC).toContain('const ORANGE = "#f76707"');
  });
});

describe("🔴 `คุยกับแอดมิน` is on both menus — the invariant that had no test", () => {
  test("`menuHasAdminButton` holds for the two REQ-079 menus", () => {
    // *"A lockout or a handover must never be a dead end"* has been a paragraph in `line-rich-menu.ts` since
    // TASK-234 and nothing called the function written to prove it.
    expect(menuHasAdminButton(UNKNOWN_RICH_MENU)).toBe(true);
    expect(menuHasAdminButton(KNOWN_RICH_MENU)).toBe(true);
  });

  test("…and it is the BOTTOM-RIGHT cell on the known menu, in the corner both menus put it in", () => {
    // The corner is the non-negotiable half of REQ-079's table; the width was always incidental. A parent looks
    // for the way to a person in the same place, whichever menu they are on.
    const last = KNOWN_RICH_MENU.areas.at(-1)!;
    expect(last.action.data).toBe("action=admin");
    expect(last.bounds.x + last.bounds.width).toBe(2500);
    expect(last.bounds.y).toBe(843);
  });

  test("six cells, and `action=lang` took the middle of the bottom row", () => {
    // REQ-079's later table (`ภาษา` and `ช่วยเหลือ` STAY) wins over §12's 3+2 sketch.
    expect(KNOWN_RICH_MENU.areas.map((a) => a.action.data)).toEqual([
      "action=leave",
      "action=checkin",
      "action=mycourses",
      "action=register",
      "action=lang",
      "action=admin",
    ]);
  });

  test("🚫 the shipped REQ-015 menus are untouched by this task", () => {
    expect(PARENT_RICH_MENU.areas).toHaveLength(6);
    expect(TEACHER_RICH_MENU.areas.map((a) => a.action.data)).toEqual(["action=schedule", "action=lang"]);
  });
});

describe("🔴 the publish path — the reason the menus never reached a phone", () => {
  const PUB = fn(SRC, "export async function publishRichMenus");

  test("it creates and uploads all SIX menus", () => {
    for (const def of [
      "PARENT_RICH_MENU)",
      "PARENT_RICH_MENU_EN)",
      "TEACHER_RICH_MENU)",
      "TEACHER_RICH_MENU_EN)",
      "UNKNOWN_RICH_MENU)",
      "KNOWN_RICH_MENU)",
    ]) {
      expect(code(PUB)).toContain(`createRichMenu(${def}`);
    }
    expect(code(PUB).match(/uploadRichMenuImage\(/g)).toHaveLength(6);
  });

  test("🔑 it STORES `unknownTH` and `knownTH` — the ids the runtime has been reading for", () => {
    // `linkKnownRichMenu` has read `ids.knownTH` since TASK-234 and nothing ever wrote it. That single missing
    // write is the whole of what a parent saw as "the menu never changed".
    expect(code(PUB)).toContain("const ids: MenuIds = { parentTH, parentEN, teacherTH, teacherEN, unknownTH, knownTH }");
    expect(code(SRC)).toContain("const target = lang === \"EN\" ? ids.knownEN : ids.knownTH");
  });

  test("🔴 the ACCOUNT DEFAULT is the unknown menu, not the old parent menu", () => {
    // The file's own note says ยังไม่รู้จัก is where a chat lands with no code running — and the only call that
    // sets a default pointed at the REQ-015 parent menu. The design and the code disagreed; the code is what runs.
    expect(code(PUB)).toContain("setDefaultRichMenu(unknownTH)");
    expect(code(PUB)).not.toContain("setDefaultRichMenu(parentTH)");
  });

  test("the publish command refuses BEFORE any LINE call when an image is missing", () => {
    // Six images now, one contract: a run that cannot finish must not start, or the channel is left with some
    // menus created and others not — and the ids of the half that succeeded are already stored.
    expect(PUBLISH).toContain('unknownThImage: "assets/line/unknown-th.png"');
    expect(PUBLISH).toContain('knownThImage: "assets/line/known-th.png"');
    const main = fn(PUBLISH, "async function main");
    expect(main.indexOf("preflightErrors")).toBeLessThan(main.indexOf("publishRichMenus("));
  });
});

describe("🔴 `storeMenuIds` MERGES — a partial publish must not erase what it did not create", () => {
  test("a second, partial write keeps the earlier ids", () => {
    // The concrete sequence this prevents: publish stores all six, then `line:adopt-menus` — which knows only
    // the four REQ-015 names — writes its four and silently drops `unknownTH`/`knownTH`. The bot goes back to
    // finding nothing, exactly as it did before this task, and nothing reports an error.
    const after = mergeMenuIds(
      { parentTH: "p1", teacherTH: "t1", unknownTH: "u1", knownTH: "k1" },
      { parentTH: "p2", teacherTH: "t2" },
    );
    expect(after).toEqual({ parentTH: "p2", teacherTH: "t2", unknownTH: "u1", knownTH: "k1" });
  });

  test("⚠️ an explicit `undefined` does NOT clobber — every field is optional, so a naive spread would", () => {
    const incoming = { knownTH: undefined, parentTH: "p2" } as MenuIds;
    expect(mergeMenuIds({ parentTH: "p1", knownTH: "k1" }, incoming)).toEqual({ parentTH: "p2", knownTH: "k1" });
  });

  test("it is the only writer's rule — `storeMenuIds` goes through it", () => {
    // Both publish and adopt (TASK-130) call `storeMenuIds`; putting the merge anywhere else would leave one of
    // them destructive.
    expect(code(fn(SRC, "export async function storeMenuIds"))).toContain("mergeMenuIds(await getMenuIds(), ids)");
  });

  test("an empty write changes nothing", () => {
    expect(mergeMenuIds({ parentTH: "p1" }, {})).toEqual({ parentTH: "p1" });
  });
});
