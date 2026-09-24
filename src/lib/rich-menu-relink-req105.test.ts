// TASK-446 (`REQ-105 §6`) — the stale per-user rich-menu link: LINE serves the channel default ONLY to a follower with no
// per-user link, so every follower linked before a re-publish keeps that publish's id forever. This pins the decision half by
// value (`expectedMenuKey` mirroring the runtime's TWO calls and its silent no-op — a TH customer ⇒ `knownTH`, an EN customer ⇒
// `parentEN`, because `knownEN` is deliberately never published; the five outcomes; the de-dupe), the user census by source and
// by value (teachers first; the three unswept tables named), the plan's printed shape, the script's flow by source (dry-run
// writes nothing · the confirmation phrase carries the count · only `expectedId` is ever written · a per-user failure continues),
// and the publish-time warning. No migration (55 = 55).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { dedupeMenuUsers, expectedMenuKey, formatRelinkPlan, planRelink, type MenuUser } from "./line-relink-plan";
import { listMenuUsers, countMenuUsers } from "./line-menu-users";
import { publishRelinkWarning } from "./line-rich-menu";
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
const SCRIPT = code(readFileSync(resolve(root, "scripts/line-relink-menus.ts"), "utf8"));
const MENU = code(src("src/lib/line-rich-menu.ts"));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

/** The ids a current publish stores: the six it creates. `knownEN` / `unknownEN` are deliberately absent (TASK-247 §4). */
const IDS = { parentTH: "p-th", parentEN: "p-en", teacherTH: "t-th", teacherEN: "t-en", unknownTH: "u-th", knownTH: "k-th" };
const user = (over: Partial<MenuUser> = {}): MenuUser => ({ lineUserId: "U1", name: "Khwan", role: "customer", lang: "TH", linkedMenuId: null, ...over });

describe("🔴 the expected menu MIRRORS the runtime's two calls — including the no-op that leaves an EN customer on `parentEN`", () => {
  test("`expectedMenuKey` by value: TH customer ⇒ knownTH (the second call wins); EN customer ⇒ parentEN (knownEN unpublished); teachers ⇒ their own; nothing published ⇒ null", () => {
    expect(expectedMenuKey("customer", "TH", IDS)).toBe("knownTH");
    expect(expectedMenuKey("customer", "EN", IDS)).toBe("parentEN");
    expect(expectedMenuKey("teacher", "TH", IDS)).toBe("teacherTH");
    expect(expectedMenuKey("teacher", "EN", IDS)).toBe("teacherEN");
    expect(expectedMenuKey("customer", "EN", { ...IDS, knownEN: "k-en" })).toBe("knownEN"); // if an EN known menu is ever published, the rule follows it
    expect(expectedMenuKey("customer", "TH", { parentTH: "p-th" })).toBe("parentTH"); // no known menu ⇒ the role link is the last one that took
    expect(expectedMenuKey("teacher", "EN", { teacherTH: "t-th" })).toBeNull();
    expect(expectedMenuKey("customer", "TH", {})).toBeNull();
    // the source it mirrors: the role link, then the customer's known link, which is a silent no-op when unpublished
    const SETTLE = region(code(src("src/services/line-register.service.ts")), "export async function settleLinkedRole(", "\n}\n");
    expect(SETTLE).toContain("await linkRoleRichMenu(lineUserId, role, seed);");
    expect(SETTLE).toContain('if (role === "customer") await linkKnownRichMenu(lineUserId, seed);');
    // 🔻 TASK-452: both linkers now resolve through the ONE rule (`menuIdFor`) — the known link keeps its meaning and
    // its name, it simply no longer spells the rule out for itself. The best-effort "no id ⇒ leave the chat alone" is
    // unchanged; it lives in the one resolver now.
    expect(region(MENU, "export async function linkKnownRichMenu(", "\n}\n")).toContain('await linkResolvedRichMenu(userId, "customer", lang);');
    expect(region(MENU, "async function linkResolvedRichMenu(", "\n}\n")).toContain("if (target) await linkRichMenuToUser(userId, target);");
    expect(MENU).toContain("[KNOWN_RICH_MENU.name]: \"knownTH\",");
    expect(region(MENU, "export const NAME_TO_KEY", "};")).not.toContain("knownEN"); // never published, by design
  });
  test("the five outcomes by value — ok · stale · variant · unlinked · blocked; `toRelink` is the three fixable ones, in order", () => {
    const users = [
      user({ lineUserId: "U-ok", name: "Ok", linkedMenuId: "k-th" }),
      user({ lineUserId: "U-stale", name: "Khwan", lang: "EN", linkedMenuId: "old-known-en" }), // an id from a PREVIOUS publish
      user({ lineUserId: "U-var", name: "Toggled", linkedMenuId: "p-th" }), // one of ours, but the toggle path left it
      user({ lineUserId: "U-none", name: "Never", linkedMenuId: null }),
      user({ lineUserId: "U-teach", name: "Ek", role: "teacher", lang: "EN", linkedMenuId: "t-en" }),
      user({ lineUserId: "U-blocked", name: "NoMenu", role: "teacher", lang: "EN", linkedMenuId: "whatever" }),
    ];
    const plan = planRelink(users, { ...IDS, teacherEN: undefined as any });
    expect(plan.rows.map((r) => [r.user.name, r.outcome, r.expectedLabel, r.linkedLabel])).toEqual([
      ["Ok", "ok", "knownTH", "knownTH"],
      ["Khwan", "stale", "parentEN", null],
      ["Toggled", "variant", "knownTH", "parentTH"],
      ["Never", "unlinked", "knownTH", null],
      ["Ek", "no-menu-published", null, null],
      ["NoMenu", "no-menu-published", null, null],
    ]);
    expect(plan.toRelink.map((r) => [r.user.lineUserId, r.expectedId])).toEqual([["U-stale", "p-en"], ["U-var", "k-th"], ["U-none", "k-th"]]);
    expect(plan.counts).toEqual({ ok: 1, stale: 1, variant: 1, unlinked: 1, "no-menu-published": 2 });
    // 🔑 Khwan's case with everything published: the stale EN id ⇒ re-linked to the CURRENT `parentEN`
    const fixed = planRelink([user({ name: "Khwan", lang: "EN", linkedMenuId: "old-known-en" })], IDS);
    expect(fixed.toRelink[0]).toMatchObject({ outcome: "stale", expectedLabel: "parentEN", expectedId: "p-en" });
    // …and if her stored lang is TH, the same stale link lands on `knownTH` — the sweep prints the lang it used either way
    expect(planRelink([user({ name: "Khwan", lang: "TH", linkedMenuId: "old-known-en" })], IDS).toRelink[0]!.expectedLabel).toBe("knownTH");
  });
  test("`dedupeMenuUsers`: one account listed twice keeps the FIRST (the script feeds teachers first, so a coach who is also a parent keeps the teacher menu)", () => {
    const out = dedupeMenuUsers([
      user({ lineUserId: "U1", name: "Ek", role: "teacher" }),
      user({ lineUserId: "U1", name: "Ek the parent", role: "customer" }),
      user({ lineUserId: "U2", name: "Mum" }),
      user({ lineUserId: "U2", name: "Mum (family link)" }),
    ]);
    expect(out.map((u) => [u.lineUserId, u.role, u.name])).toEqual([["U1", "teacher", "Ek"], ["U2", "customer", "Mum"]]);
  });
  test("the printed plan: the account FIRST, the mode, one line per user with the language, the counts, and the blocked warning", () => {
    const plan = planRelink([user({ name: "Khwan", lang: "EN", linkedMenuId: "old-known-en" }), user({ lineUserId: "U2", name: "Ek", role: "teacher", lang: "EN", linkedMenuId: "t-en" })], { ...IDS, teacherEN: undefined as any });
    const out = formatRelinkPlan(plan, { apply: false, account: "SOM-Balance-Demo" });
    const lines = out.split("\n");
    expect(lines[0]).toBe("LINE account: SOM-Balance-Demo");
    expect(lines[1]).toBe("MODE: dry run (nothing is written)");
    expect(lines[3]).toContain("RELINK");
    expect(lines[3]).toContain("Khwan");
    expect(lines[3]).toContain("customer");
    expect(lines[3]).toContain("EN");
    expect(lines[3]).toContain("linked unknown-id");
    expect(lines[3]).toContain("expected parentEN");
    expect(lines[4]).toContain("BLOCKED");
    expect(lines[4]).toContain("expected — none published —");
    expect(out).toContain("2 known LINE account(s): 0 ok · 1 stale · 0 variant · 0 unlinked · 1 blocked (no menu published)");
    expect(out).toContain("⚠️  BLOCKED users hold no fixable menu");
    expect(formatRelinkPlan(planRelink([user({ linkedMenuId: "k-th" })], IDS), { apply: true, account: "X" })).toContain("MODE: --apply (links will be written)");
    expect(formatRelinkPlan(planRelink([user({ linkedMenuId: "k-th" })], IDS), { apply: true, account: "X" })).not.toContain("BLOCKED users hold");
  });
});

describe("🔴 the user census — teachers first, both customer sources, the three unswept tables named", () => {
  test("`listMenuUsers` by value: teachers (not archived) · parents' primary column · every `family_line_links` row, deduplicated; the language from the row, null ⇒ TH", async () => {
    const exec: any = {
      query: {
        teachers: { findMany: async () => [{ id: "t1", name: "Ekachai", nickname: "Ek", lineUserId: "U-ek", lineLang: "EN", archived: false }, { id: "t2", name: "Gone", nickname: null, lineUserId: "U-gone", lineLang: null, archived: true }, { id: "t3", name: "NoLine", nickname: "N", lineUserId: null, lineLang: null, archived: false }] },
        parents: { findMany: async () => [{ id: "p1", name: "Khwan", phone: "0924912848", lineUserId: "U-khwan", lineLang: null }, { id: "p2", name: null, phone: "0811111111", lineUserId: null, lineLang: "EN" }] },
      },
      select: () => ({ from: async () => [{ parentId: "p1", lineUserId: "U-khwan" }, { parentId: "p1", lineUserId: "U-dad" }, { parentId: "p2", lineUserId: "U-p2" }] }),
    };
    expect(await listMenuUsers(exec)).toEqual([
      { lineUserId: "U-ek", name: "Ek", role: "teacher", lang: "EN", linkedMenuId: null },
      { lineUserId: "U-khwan", name: "Khwan", role: "customer", lang: "TH", linkedMenuId: null }, // the primary column; null lang ⇒ TH
      { lineUserId: "U-dad", name: "Khwan", role: "customer", lang: "TH", linkedMenuId: null }, // the second phone on the same family
      { lineUserId: "U-p2", name: "0811111111", role: "customer", lang: "EN", linkedMenuId: null }, // no name ⇒ the phone, for the operator's eyes
    ]);
    expect(await countMenuUsers(exec)).toBe(4);
  });
  test("by source: the unswept tables are named and NOT read — `students`, `line_link_sessions`, `teacher_link_requests`", () => {
    const U = src("src/lib/line-menu-users.ts");
    expect(U).toContain("`students` (a");
    expect(U).toContain("`line_link_sessions`");
    expect(U).toContain("`teacher_link_requests`");
    const C = code(U);
    expect(C).not.toMatch(/query\.students|lineLinkSessions|teacherLinkRequests/);
    expect(C).toContain("import { familyLineLinks, parents, teachers } from \"../db/schema\";");
  });
});

describe("🔴 the script and the publish warning — the plan is the deliverable; a publish never ends silently", () => {
  test("the script by source: dry-run writes nothing, the phrase carries the count, only `expectedId` is written, a failure continues, no delete / unlink anywhere", () => {
    expect(SCRIPT).toContain("export const confirmationPhrase = (count: number) => `RELINK ${count}`;");
    expect(SCRIPT).toContain("const typed = prompt(`\\nType \"${expected}\" to proceed (anything else cancels):`);");
    expect(SCRIPT).toContain('if (typed?.trim() !== expected) {');
    expect(SCRIPT).toContain("const expected = confirmationPhrase(plan.toRelink.length);");
    expect(SCRIPT).toContain("await linkRichMenuToUser(r.user.lineUserId, r.expectedId!);");
    expect(SCRIPT.indexOf("console.log(formatRelinkPlan(plan, { apply, account }));")).toBeLessThan(SCRIPT.indexOf("if (!apply)"));
    expect(SCRIPT.indexOf("if (!apply)")).toBeLessThan(SCRIPT.indexOf("await linkRichMenuToUser("));
    expect(region(SCRIPT, "for (const r of plan.toRelink) {", "\n  }")).toContain("} catch (e) {"); // a per-user failure is reported, the sweep continues
    expect(SCRIPT).not.toMatch(/deleteRichMenu|unlinkRichMenuFromUser|clearDefaultRichMenu|clearMenuIds/);
    expect(SCRIPT).toContain("const [account, ids, users] = await Promise.all([getBotAccountLabel(), getMenuIds(), listMenuUsers()]);");
    expect(SCRIPT).toContain("u.linkedMenuId = await getUserRichMenuId(u.lineUserId);");
    expect(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts["line:relink-menus"]).toBe("bun run scripts/line-relink-menus.ts");
  });
  test("`publishRichMenus` ends with the warning — the count when it can be read, the honest line when it cannot; never throws", async () => {
    const P = region(MENU, "export async function publishRichMenus(", "\n}\n");
    expect(P).toContain("for (const line of await publishRelinkWarning()) console.warn(line);");
    expect(P.indexOf("publishRelinkWarning")).toBeGreaterThan(P.indexOf("await setDefaultRichMenu(unknownTH);"));
    const users = spyOn(await import("./line-menu-users"), "countMenuUsers");
    // the count path
    users.mockImplementation((async () => 7) as any); spies.push(users);
    let out = await publishRelinkWarning();
    expect(out[0]).toContain("7 follower(s) still hold the menu ids of the PREVIOUS publish");
    expect(out[0]).toContain("line:relink-menus --dry-run");
    expect(out[1]).toContain("The channel default only serves followers with NO per-user link");
    // a failed count must not fail a publish
    users.mockImplementation((async () => { throw new Error("db down"); }) as any);
    out = await publishRelinkWarning();
    expect(out[0]).toContain("Followers still hold the menu ids of the PREVIOUS publish");
    expect(out[0]).not.toContain("null");
    expect(readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).length).toBe(55); // no migration
  });
});
