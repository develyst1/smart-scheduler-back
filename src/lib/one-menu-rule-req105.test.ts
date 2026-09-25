// TASK-452 (`REQ-105 §6b`) — 🔴 Tanya, on the build carrying 446–451: link ⇒ the ORANGE menu; first Language tap ⇒
// the OLD BLUE one, both ways, and blue from then on. The cause: `app_settings` held TWO families (the REQ-015 blue
// `parent*`/`teacher*` and the REQ-079 orange `known*`), and the two LIVE paths spelled the rule out for themselves —
// the link called the role linker then the known linker (orange), the toggle only the role linker (blue). TASK-452's fix:
// `menuIdFor` is the ONE answer and every caller asks it.
//
// 🔻 TASK-468 (REQ-107 §1) — **the drift class is now retired at the ROOT, not only guarded.** The owner's artwork is
// bilingual, so there is ONE menu per ROLE: no language axis in the rule, no second family to fall into, and the language
// toggle no longer links a menu at all. What stays from TASK-452 is its principle — ONE rule, asked by every caller — and
// what this file now pins is that rule in its new shape, plus the legacy fallback that keeps a not-yet-republished box
// working, plus the toggle's ABSENCE of any link.
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
/** An OLD box: only the per-language families are stored (what every OA holds before the TASK-468 publish). */
const OLD: MenuIds = { parentTH: "blue-th", parentEN: "blue-en", teacherTH: "t-blue-th", teacherEN: "t-blue-en", unknownTH: "orange-unknown", knownTH: "orange-known" };
/** A box AFTER the per-role publish: the three new ids, stored BESIDE the old ones (the merge keeps them). */
const NEW: MenuIds = { ...OLD, unknown: "role-unknown", customer: "role-customer", teacher: "role-teacher" };
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

/** The live linker over a faked `app_settings` + a recorded `POST /user/{id}/richmenu/{id}`. */
const linkChat = (ids: MenuIds) => {
  const linked: string[] = [];
  spies.push(spyOn(menu, "getMenuIds").mockImplementation((async () => ids) as any));
  spies.push(spyOn(menu, "linkRichMenuToUser").mockImplementation((async (_u: string, id: string) => { linked.push(id); }) as any));
  return { linked };
};

describe("🔴 ONE rule — `menuIdFor(role, ids)`, by value: no language, the per-role id wins", () => {
  test("after the per-role publish: a customer gets the CUSTOMER menu, a teacher the TEACHER menu — the old ids are ignored", () => {
    expect(menuIdFor("customer", NEW)).toBe("role-customer");
    expect(menuIdFor("teacher", NEW)).toBe("role-teacher");
    expect(menuIdFor("customer", NEW)).toBe(NEW[expectedMenuKey("customer", NEW)!] ?? null); // the id half ≡ the key half
  });

  test("🔑 the LEGACY FALLBACK — a box that deployed the code but has not re-published keeps linking what it did for a TH chat", () => {
    expect(menuIdFor("customer", OLD)).toBe("orange-known"); // knownTH first…
    const { knownTH: _k, ...noKnown } = OLD;
    expect(menuIdFor("customer", noKnown)).toBe("blue-th"); // …then parentTH
    expect(menuIdFor("teacher", OLD)).toBe("t-blue-th");
    // TH only, on purpose: the EN variants ARE the gap this change closes — an EN chat gets what an EN customer already got
    expect(menuIdFor("customer", { parentEN: "blue-en", knownEN: "orange-en" })).toBeNull();
  });

  test("nothing published ⇒ nothing to link (the chat keeps the channel default) — best-effort, unchanged", () => {
    expect(menuIdFor("customer", {})).toBeNull();
    expect(menuIdFor("teacher", {})).toBeNull();
  });

  test("🔑 the `knownEN` gap closes ITSELF: the rule has no language to be missing a menu in", () => {
    expect(menuIdFor.length).toBe(2); // role, ids — no `lang` parameter left anywhere in the rule
    expect(expectedMenuKey.length).toBe(2);
  });
});

describe("🔴 the drift class TASK-452 fixed — retired at the root", () => {
  test("by value: the ONE linker links the role's menu, whatever language the chat speaks — there is no language to pass", async () => {
    const c = linkChat(NEW);
    await menu.linkRoleRichMenu(U, "customer");
    await menu.linkRoleRichMenu(U, "teacher");
    expect(c.linked).toEqual(["role-customer", "role-teacher"]);
    for (const s of spies.splice(0)) s.mockRestore();
    const empty = linkChat({});
    await menu.linkRoleRichMenu(U, "customer");
    expect(empty.linked).toEqual([]); // best-effort: nothing published ⇒ nothing linked
  });

  test("🔑 the LANGUAGE TOGGLE links NO menu at all — it flips the bot's language and answers, nothing else", () => {
    const toggle = region(WEBHOOK, 'if (action === "lang") {', "\n  }");
    expect(toggle).toContain("await toggleLang(lineUserId, lang);");
    expect(toggle).not.toMatch(/linkRoleRichMenu|linkRichMenuToUser|linkKnownRichMenu|getMenuIds/);
  });

  test("`linkKnownRichMenu` is GONE — the two-step rule (role menu, then known on top) has one step", () => {
    expect(MENU).not.toContain("linkKnownRichMenu");
    expect(code(src("src/services/line-register.service.ts"))).not.toContain("linkKnownRichMenu");
    expect(region(MENU, "async function linkResolvedRichMenu(", "\n}\n")).toContain("const target = menuIdFor(role, await getMenuIds());");
  });

  test("🚫 nothing outside the rule's own file reads a menu key to choose a link", () => {
    for (const f of ["src/lib/line-rich-menu.ts", "src/services/line-webhook.service.ts", "src/services/line-register.service.ts", "src/services/teacher-link.service.ts"]) {
      expect({ f, picks: /ids\.(known|parent|teacher|customer|unknown)(TH|EN)?\b/.test(code(src(f))) }).toEqual({ f, picks: false });
    }
    expect((code(src("src/lib/line-relink-plan.ts")).match(/export function menuIdFor\(/g) ?? []).length).toBe(1);
  });
});

describe("🔴 link ≡ sweep — and `variant` is THE MIGRATION PATH (Sober's §3 ruling)", () => {
  const user = (linkedMenuId: string | null, role: "customer" | "teacher" = "customer"): MenuUser => ({ lineUserId: U, name: "Khwan", role, lang: "TH", linkedMenuId });

  test("🔑 right after the per-role publish, a follower still on an OLD id reads as `variant` — and the sweep moves them to the ROLE menu", () => {
    const plan = planRelink([user("orange-known"), user("blue-en"), user("t-blue-th", "teacher")], NEW);
    expect(plan.rows.map((r) => [r.outcome, r.expectedId])).toEqual([
      ["variant", "role-customer"],
      ["variant", "role-customer"],
      ["variant", "role-teacher"],
    ]);
    expect(plan.toRelink).toHaveLength(3);
  });

  test("a follower already on the role menu is `ok`; the sweep's expectation IS the live link's target", () => {
    const plan = planRelink([user("role-customer")], NEW);
    expect(plan.rows[0]).toMatchObject({ outcome: "ok", expectedId: menuIdFor("customer", NEW) });
    expect(code(src("src/lib/line-relink-plan.ts"))).toContain("const expectedId = menuIdFor(user.role, ids);");
  });

  test("…and on an OLD box (no per-role ids yet) the sweep expects exactly what the legacy fallback links — no churn before the publish", () => {
    expect(planRelink([user("orange-known")], OLD).rows[0]).toMatchObject({ outcome: "ok", expectedId: "orange-known" });
  });
});
