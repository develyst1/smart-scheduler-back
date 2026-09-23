// TASK-452 (`REQ-105 §6b`) — 🔴 Tanya, on the build carrying 446–451: link ⇒ the ORANGE menu; first Language tap ⇒
// the OLD BLUE one, both ways, and blue from then on.
//
// The cause is not a stale id store. `app_settings.line_rich_menu_ids` holds TWO families — the REQ-015 `parent*` /
// `teacher*` (blue) and the REQ-079 `known*` (orange) — and holds them correctly (`storeMenuIds` MERGES, TASK-247).
// The defect is that the two LIVE paths each spelled the rule out for themselves: the account-link called the role
// linker and THEN the known linker (last write wins ⇒ orange), while the toggle called only the role linker ⇒ blue.
// This pins the fix: `menuIdFor` is the ONE answer, three callers ask it, and the toggle-linked id ≡ the id the
// account-link sets ≡ the id the relink sweep expects.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expectedMenuKey, menuIdFor, planRelink, type MenuUser } from "./line-relink-plan";
import * as menu from "./line-rich-menu";
import type { MenuIds } from "./line-rich-menu";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const MENU = code(src("src/lib/line-rich-menu.ts"));
const WEBHOOK = code(src("src/services/line-webhook.service.ts"));
const U = "Uaeeb9c20ca9";
/** What a current publish leaves in `app_settings`: BOTH families, `knownEN` deliberately absent (TASK-247 §4). */
const IDS: MenuIds = { parentTH: "blue-th", parentEN: "blue-en", teacherTH: "t-blue-th", teacherEN: "t-blue-en", unknownTH: "orange-unknown", knownTH: "orange-known" };
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

/** The two live linkers over a faked `app_settings` + a recorded `POST /user/{id}/richmenu/{id}`. */
const linkChat = (ids: Record<string, string> = IDS) => {
  const linked: string[] = [];
  spies.push(spyOn(menu, "getMenuIds").mockImplementation((async () => ids) as any));
  spies.push(spyOn(menu, "linkRichMenuToUser").mockImplementation((async (_u: string, id: string) => { linked.push(id); }) as any));
  return { linked };
};

describe("🔴 ONE rule — `menuIdFor`, by value", () => {
  test("a bound customer gets the ORANGE known menu in TH; in EN there is none published, so the rule falls back to the blue `parentEN`", () => {
    expect(menuIdFor("customer", "TH", IDS)).toBe("orange-known");
    expect(menuIdFor("customer", "EN", IDS)).toBe("blue-en"); // 🔴 the `knownEN` hole, stated: EN stays blue until artwork exists
    expect(menuIdFor("teacher", "TH", IDS)).toBe("t-blue-th");
    expect(menuIdFor("teacher", "EN", IDS)).toBe("t-blue-en");
    // …and when an EN known menu IS published one day, the same rule follows it with no code change
    expect(menuIdFor("customer", "EN", { ...IDS, knownEN: "orange-known-en" })).toBe("orange-known-en");
    expect(menuIdFor("customer", "TH", {})).toBeNull(); // nothing published ⇒ nothing to link (the chat keeps the default)
    expect(menuIdFor("customer", "TH", IDS)).toBe(IDS[expectedMenuKey("customer", "TH", IDS)!] ?? null); // the id half ≡ the key half
  });
});

describe("🔴 THE DEFECT: the toggle used a different FAMILY — now it asks the same rule", () => {
  test("🔴 a TH customer toggles TH→EN→TH and comes back to the id the account-link set (orange), never the blue one", async () => {
    const c = linkChat();
    // the account-link's sequence (`settleLinkedRole`): role, then known for a customer
    await menu.linkRoleRichMenu(U, "customer", "TH");
    await menu.linkKnownRichMenu(U, "TH");
    const afterLink = c.linked.at(-1);
    expect(afterLink).toBe("orange-known");
    // the TOGGLE's single call — the one that used to land on `parentEN`/`parentTH`
    await menu.linkRoleRichMenu(U, "customer", "EN");
    expect(c.linked.at(-1)).toBe("blue-en"); // correct BY THE RULE: no `knownEN` exists to link to
    await menu.linkRoleRichMenu(U, "customer", "TH");
    expect(c.linked.at(-1)).toBe("orange-known"); // 🔑 back to exactly what the link set — the old build gave `blue-th`
    expect(c.linked.at(-1)).toBe(afterLink);
    // 🔑 Porter's pin, all three paths on one id: link ≡ toggle ≡ what the sweep would set
    const user: MenuUser = { lineUserId: U, name: "Khwan", role: "customer", lang: "TH", linkedMenuId: c.linked.at(-1)! };
    expect(planRelink([user], IDS).rows[0]).toMatchObject({ outcome: "ok", expectedId: "orange-known" });
  });
  test("a TEACHER's toggle stays in the teacher family both ways; an unpublished menu leaves the chat alone", async () => {
    const c = linkChat();
    await menu.linkRoleRichMenu(U, "teacher", "TH");
    await menu.linkRoleRichMenu(U, "teacher", "EN");
    await menu.linkRoleRichMenu(U, "teacher", "TH");
    expect(c.linked).toEqual(["t-blue-th", "t-blue-en", "t-blue-th"]);
    for (const s of spies.splice(0)) s.mockRestore();
    const empty = linkChat({});
    await menu.linkRoleRichMenu(U, "customer", "TH");
    await menu.linkKnownRichMenu(U, "TH");
    expect(empty.linked).toEqual([]); // best-effort, unchanged: nothing published ⇒ nothing linked
  });
  test("the customer's TWO link calls now agree — the second is a re-link to the same id, not a different family", async () => {
    const c = linkChat();
    await menu.linkRoleRichMenu(U, "customer", "TH");
    await menu.linkKnownRichMenu(U, "TH");
    expect(c.linked).toEqual(["orange-known", "orange-known"]);
  });
});

describe("🔴 one rule, three callers — by source", () => {
  test("both linkers resolve through the ONE resolver, and nothing outside it picks a menu by key", () => {
    expect(region(MENU, "async function linkResolvedRichMenu(", "\n}\n")).toContain('const target = menuIdFor(role, lang === "EN" ? "EN" : "TH", await getMenuIds());');
    expect(region(MENU, "export async function linkKnownRichMenu(", "\n}\n")).toContain('await linkResolvedRichMenu(userId, "customer", lang);');
    expect(region(MENU, "export async function linkRoleRichMenu(", "\n}\n")).toContain("await linkResolvedRichMenu(userId, role, lang);");
    // 🚫 no second spelling: outside the rule's own file nothing reads `ids.parentTH`-shaped keys to choose a link
    expect(MENU).not.toMatch(/ids\.(known|parent|teacher)(TH|EN)/);
    expect(code(src("src/services/line-webhook.service.ts"))).not.toMatch(/ids\.(known|parent|teacher)(TH|EN)/);
    expect(code(src("src/services/line-register.service.ts"))).not.toMatch(/ids\.(known|parent|teacher)(TH|EN)/);
    // the rule's own file is the ONE place the keys are named
    const PLAN = code(src("src/lib/line-relink-plan.ts"));
    expect(PLAN).toContain('const roleKey = ((role === "teacher" ? "teacher" : "parent") + lang) as keyof MenuIds;');
    expect(PLAN).toContain('const knownKey = (lang === "EN" ? "knownEN" : "knownTH") as keyof MenuIds;');
    expect((PLAN.match(/export function menuIdFor\(/g) ?? []).length).toBe(1);
  });
  test("the three callers: the account-link, the language toggle, the relink sweep", () => {
    expect(code(src("src/services/line-register.service.ts"))).toContain("await linkRoleRichMenu(lineUserId, role, seed);");
    expect(region(WEBHOOK, 'if (action === "lang") {', "\n  }")).toContain("await linkRoleRichMenu(lineUserId, linked, next);");
    expect(code(src("src/lib/line-relink-plan.ts"))).toContain("const expectedId = menuIdFor(user.role, user.lang, ids);");
    // the sweep's own expectation and the live link are now literally the same expression
    expect(planRelink([{ lineUserId: U, name: "x", role: "customer", lang: "TH", linkedMenuId: "blue-th" }], IDS).toRelink[0]).toMatchObject({ outcome: "variant", expectedId: menuIdFor("customer", "TH", IDS) });
  });
});
