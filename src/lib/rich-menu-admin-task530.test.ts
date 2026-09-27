// TASK-530 (owner ruling (a), 2026-09-27) — the ADMIN's one-cell rich menu.
//
// LINE has no per-user "no menu": an admin with no link sees the account default, which is the UNKNOWN menu (Sign Up + Chat with
// Admin — both wrong for staff). So an admin gets ONE cell that opens the web app. Pinned here: the cell IS the whole image · only
// this menu may carry a link (every other area stays a postback) · the link is refused when its base is missing or bad, BEFORE any
// LINE call · the sweep never reads an admin as needing the unknown menu · the link door · the other menus and the account default
// unchanged · the artwork cannot be overwritten by another generator.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as rich from "./line-rich-menu";
import {
  ADMIN_MENU,
  ALL_MENU_DEFS,
  CUSTOMER_MENU,
  TEACHER_MENU,
  UNKNOWN_MENU,
  adminMenuFor,
  adminMenuUrl,
  createRichMenu,
  menuHasAdminButton,
  publishRichMenus,
} from "./line-rich-menu";
import { expectedMenuKey, menuIdFor, planRelink, type MenuUser } from "./line-relink-plan";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { adminUrlProblem, preflightErrors, IMAGE_PATHS } = await import("../../scripts/line-publish-menus");
const { formatMenu } = await import("../../scripts/line-inspect-menus");
const { settleAdminLink } = await import("../services/line-register.service");

const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const src = (f: string) => code(readSrc(readFileSync(resolve(root, f), "utf8")));
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const BASE = "https://admin.example.test";

describe("🔑 ONE cell — the whole picture is the tap target", () => {
  test("exactly one area, and its bounds ARE the menu's size (a half-width hit-box looks right and taps wrong)", () => {
    const m = adminMenuFor(adminMenuUrl(BASE));
    expect(m.size).toEqual({ width: 2500, height: 843 });
    expect(m.areas).toHaveLength(1);
    expect(m.areas[0].bounds).toEqual({ x: 0, y: 0, width: m.size.width, height: m.size.height });
    expect(m.areas[0].action).toEqual({ type: "uri", uri: "https://admin.example.test/?openExternalBrowser=1" });
    expect({ name: m.name, chatBarText: m.chatBarText, selected: m.selected }).toEqual({ name: "smart-scheduler-admin", chatBarText: "เมนู | Menu", selected: false });
  });
  test("the image is its own file at exactly that size, ≤ 1,000,000 bytes (the shared size test also pairs it)", () => {
    const buf = readFileSync(resolve(root, IMAGE_PATHS.adminImage));
    expect({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }).toEqual({ w: 2500, h: 843 });
    expect(statSync(resolve(root, IMAGE_PATHS.adminImage)).size).toBeLessThanOrEqual(1_000_000);
  });
});

describe("🔴 the widening is NARROW — only the admin menu opens a link", () => {
  test("every other menu we define has postback areas only; the admin menu is the one uri", () => {
    const withUri = ALL_MENU_DEFS.filter((m) => m.areas.some((a) => a.action.type === "uri")).map((m) => m.name);
    expect(withUri).toEqual([ADMIN_MENU.name]);
    for (const m of ALL_MENU_DEFS.filter((d) => d.name !== ADMIN_MENU.name)) {
      expect({ m: m.name, types: [...new Set(m.areas.map((a) => a.action.type))] }).toEqual({ m: m.name, types: ["postback"] });
    }
  });
  test("…and by TYPE: `RichMenuArea` stays postback-only; the uri area is its own type", () => {
    const S = src("src/lib/line-rich-menu.ts");
    const area = region(S, "export interface RichMenuArea {", "\n}\n");
    expect(area).toContain('action: { type: "postback"; data: string; label?: string };');
    expect(area).not.toContain('"uri"');
    expect(S).toContain("export interface AdminMenuDef extends Omit<RichMenuDef, \"areas\"> {\n  areas: [UriMenuArea];");
  });
});

describe("🔴 the link — `openExternalBrowser`, and the REFUSAL (the important half)", () => {
  test("the base + LINE's `openExternalBrowser=1` (⚠️ documented LINE behaviour, not observed on a device); a trailing slash or a path is kept tidy", () => {
    expect(adminMenuUrl("https://admin.example.test/")).toBe("https://admin.example.test/?openExternalBrowser=1");
    expect(adminMenuUrl("  https://example.test/app//  ")).toBe("https://example.test/app/?openExternalBrowser=1");
  });
  test("REFUSED: missing · empty · not a URL · not https · carrying ? or #", () => {
    for (const bad of [undefined, null, "", "   ", "admin.example.test", "http://admin.example.test", "https://a.test/?x=1", "https://a.test/#top"]) {
      expect({ bad, threw: (() => { try { adminMenuUrl(bad as any); return false; } catch { return true; } })() }).toEqual({ bad, threw: true });
    }
  });
  test("the publish SCRIPT refuses before any LINE call — the problem is a preflight error", () => {
    expect(adminUrlProblem(undefined)).toContain("PUBLIC_ADMIN_BASE_URL is not set");
    expect(adminUrlProblem(BASE)).toBeNull();
    expect(preflightErrors(true, [], adminUrlProblem(undefined))).toEqual(["admin menu link: PUBLIC_ADMIN_BASE_URL is not set — the admin menu's link would be empty."]);
    expect(src("scripts/line-publish-menus.ts")).toContain("preflightErrors(!!process.env.LINE_CHANNEL_ACCESS_TOKEN, missing, adminUrlProblem(process.env[ADMIN_URL_ENV]))");
  });
  test("…and `publishRichMenus` itself refuses FIRST: with no base, NOTHING reaches LINE (no half-publish)", async () => {
    const calls: string[] = [];
    spies.push(spyOn(globalThis, "fetch").mockImplementation((async (u: any) => { calls.push(String(u)); throw new Error("no network in tests"); }) as any));
    const saved = process.env.PUBLIC_ADMIN_BASE_URL;
    delete process.env.PUBLIC_ADMIN_BASE_URL;
    try {
      await expect(publishRichMenus({ unknownImage: "u", customerImage: "c", teacherImage: "t", adminImage: "a" })).rejects.toThrow("PUBLIC_ADMIN_BASE_URL is not set");
    } finally {
      if (saved !== undefined) process.env.PUBLIC_ADMIN_BASE_URL = saved;
    }
    expect(calls).toEqual([]);
  });
  test("…and the unset constant can NEVER be created: `createRichMenu` refuses a link area without an https link, before fetch", async () => {
    const calls: string[] = [];
    spies.push(spyOn(globalThis, "fetch").mockImplementation((async (u: any) => { calls.push(String(u)); throw new Error("no network in tests"); }) as any));
    await expect(createRichMenu(ADMIN_MENU)).rejects.toThrow("no https link");
    expect(calls).toEqual([]);
  });
  test("`inspect-menus` shows the new menu's one area as a link (what the owner reads before a publish)", () => {
    expect(formatMenu("admin", "rm-a", adminMenuFor(adminMenuUrl(BASE)))).toBe(
      '  admin [rm-a]\n    name="smart-scheduler-admin" size=2500x843 chatBarText="เมนู | Menu" selected=false\n    areas: 1\n' +
        "      #0 (0,0 2500x843) action.type=uri data=https://admin.example.test/?openExternalBrowser=1",
    );
  });
});

describe("🔑 the sweep knows `admin` — and NEVER reads one as needing the unknown menu", () => {
  const admin = (linkedMenuId: string | null): MenuUser => ({ lineUserId: "U-a", name: "(admin …U-a)", role: "admin", lang: "TH", linkedMenuId });
  const WITH = { unknown: "u", customer: "c", teacher: "t", admin: "a", knownTH: "k-th", parentTH: "p-th", unknownTH: "u-th" };
  const WITHOUT = { unknown: "u", customer: "c", teacher: "t", knownTH: "k-th", parentTH: "p-th", unknownTH: "u-th", teacherTH: "t-th" };
  test("🔴 for ANY stored ids, an admin's expected menu is the admin menu or NOTHING — never `unknown`, never a legacy id", () => {
    expect(expectedMenuKey("admin", WITH)).toBe("admin");
    expect(expectedMenuKey("admin", WITHOUT)).toBeNull();
    expect(menuIdFor("admin", WITHOUT)).toBeNull();
    for (const ids of [WITH, WITHOUT, { unknown: "u" }, {}]) expect(menuIdFor("admin", ids)).not.toBe((ids as any).unknown ?? "∅");
  });
  test("by outcome: on the admin menu ⇒ ok · on the default ⇒ RELINK to admin · on the unknown menu ⇒ RELINK to admin (the repair) · none published ⇒ BLOCKED, left alone", () => {
    const p = planRelink([admin("a"), { ...admin(null), lineUserId: "U-b" }, { ...admin("u"), lineUserId: "U-c" }], WITH);
    expect(p.rows.map((r) => [r.user.lineUserId, r.outcome, r.expectedLabel])).toEqual([
      ["U-a", "ok", "admin"],
      ["U-b", "unlinked", "admin"],
      ["U-c", "variant", "admin"],
    ]);
    expect(p.toRelink.map((r) => r.expectedId)).toEqual(["a", "a"]);
    const blocked = planRelink([admin(null), { ...admin("u"), lineUserId: "U-c" }], WITHOUT);
    expect(blocked.rows.map((r) => r.outcome)).toEqual(["no-menu-published", "no-menu-published"]);
    expect(blocked.toRelink).toEqual([]);
  });
  test("the census lists admins LAST, after teachers and parents — `detectLinkedRole`'s own order (a coach-admin keeps the teacher menu)", () => {
    const U = src("src/lib/line-menu-users.ts");
    expect(U).toContain("const adminIds = await getAdminLineUserIds(exec);");
    const list = region(U, "const users: MenuUser[] = [", "];");
    expect(list.indexOf("...teacherRows")).toBeLessThan(list.indexOf("...parentRows"));
    expect(list.indexOf("...linkRows")).toBeLessThan(list.indexOf("...adminIds"));
    const W = src("src/services/line-webhook.service.ts");
    const detect = region(W, "async function detectLinkedRole(", "\n}\n");
    expect(detect.indexOf('return "teacher"')).toBeLessThan(detect.indexOf('return "customer"'));
    expect(detect.indexOf('return "customer"')).toBeLessThan(detect.indexOf('return "admin"'));
  });
});

describe("🔑 the link door — an admin gets the admin menu at verify, through the register door (RULE 1)", () => {
  test("verify: the admin branch links the admin menu ONLY when admin is the account's role; teacher/parent linking unchanged", () => {
    const W = src("src/services/line-webhook.service.ts");
    const branch = region(W, 'if (role === "admin") {', "\n  }\n");
    expect(branch).toContain('if ((await detectLinkedRole(lineUserId)) === "admin") await settleAdminLink(lineUserId);');
    expect(branch.indexOf("await addAdminLineUserId(lineUserId);")).toBeLessThan(branch.indexOf("settleAdminLink"));
    expect(W).toContain('if (role !== "admin") await settleLinkedRole(lineUserId, role);');
    expect(W).not.toContain("linkRoleRichMenu(lineUserId, \"admin\")"); // the chat never links a menu itself
  });
  test("`settleAdminLink` links the ADMIN menu, and a failure never breaks the verify (best-effort)", async () => {
    const got: unknown[][] = [];
    spies.push(spyOn(rich, "linkRoleRichMenu").mockImplementation((async (...a: unknown[]) => { got.push(a); }) as any));
    await settleAdminLink("U-boss");
    expect(got).toEqual([["U-boss", "admin"]]);
    spies.splice(0).forEach((s) => s.mockRestore());
    spies.push(spyOn(rich, "linkRoleRichMenu").mockImplementation((async () => { throw new Error("LINE 500"); }) as any));
    spies.push(spyOn(console, "error").mockImplementation(() => {}));
    await expect(settleAdminLink("U-boss")).resolves.toBeUndefined();
  });
});

describe("🚫 what must not move", () => {
  test("the unknown, customer and teacher menus — byte-identical definitions", () => {
    expect(JSON.stringify(UNKNOWN_MENU)).toBe('{"size":{"width":2500,"height":843},"selected":false,"name":"smart-scheduler-unknown","chatBarText":"เมนู | Menu","areas":[{"bounds":{"x":0,"y":0,"width":1250,"height":843},"action":{"type":"postback","data":"action=enter"}},{"bounds":{"x":1250,"y":0,"width":1250,"height":843},"action":{"type":"postback","data":"action=admin"}}]}');
    expect(JSON.stringify(CUSTOMER_MENU)).toBe('{"size":{"width":2500,"height":1686},"selected":false,"name":"smart-scheduler-customer","chatBarText":"เมนู | Menu","areas":[{"bounds":{"x":0,"y":0,"width":833,"height":843},"action":{"type":"postback","data":"action=leave"}},{"bounds":{"x":833,"y":0,"width":833,"height":843},"action":{"type":"postback","data":"action=checkin"}},{"bounds":{"x":1666,"y":0,"width":834,"height":843},"action":{"type":"postback","data":"action=mycourses"}},{"bounds":{"x":0,"y":843,"width":833,"height":843},"action":{"type":"postback","data":"action=register"}},{"bounds":{"x":833,"y":843,"width":833,"height":843},"action":{"type":"postback","data":"action=lang"}},{"bounds":{"x":1666,"y":843,"width":834,"height":843},"action":{"type":"postback","data":"action=admin"}}]}');
    expect(JSON.stringify(TEACHER_MENU)).toBe('{"size":{"width":2500,"height":843},"selected":false,"name":"smart-scheduler-teacher","chatBarText":"เมนู | Menu","areas":[{"bounds":{"x":0,"y":0,"width":1250,"height":843},"action":{"type":"postback","data":"action=schedule"}},{"bounds":{"x":1250,"y":0,"width":1250,"height":843},"action":{"type":"postback","data":"action=lang"}}]}');
  });
  test("the ACCOUNT DEFAULT stays the unknown menu — it is what keeps sign-up alive for new visitors", () => {
    const pub = region(src("src/lib/line-rich-menu.ts"), "export async function publishRichMenus(", "\n}\n");
    expect(pub).toContain("await setDefaultRichMenu(unknown);");
    expect(pub.match(/setDefaultRichMenu\(/g)).toHaveLength(1);
  });
  test("TASK-524's two actions untouched: the unknown menu still offers them, and the chat still handles `admin` before any role check", () => {
    expect(UNKNOWN_MENU.areas.map((a) => a.action.data)).toEqual(["action=enter", "action=admin"]);
    expect(src("src/services/line-webhook.service.ts")).toContain('if (action === "admin") return doCallAdmin(lineUserId, replyToken, lang);');
  });
  test("📌 no `คุยกับแอดมิน` on the admin menu, deliberately — the TASK-234 promise is that a PERSON is reachable, and an admin is that person; the family/visitor menus keep it", () => {
    expect(menuHasAdminButton(UNKNOWN_MENU)).toBe(true);
    expect(menuHasAdminButton(CUSTOMER_MENU)).toBe(true);
    expect(ADMIN_MENU.areas.some((a) => a.action.type !== "uri")).toBe(false);
  });
});

describe("⚠️ TASK-484's lesson — no other generator can overwrite the admin art", () => {
  test("`menu-admin.png` is named by exactly ONE script in assets/line — its own generator", () => {
    const dir = resolve(root, "assets/line");
    const naming = readdirSync(dir).filter((f) => /\.(m?js|ts)$/.test(f) && readFileSync(resolve(dir, f), "utf8").includes("menu-admin.png"));
    expect(naming).toEqual(["generate-admin-menu.mjs"]);
  });
  test("…and that generator writes ONLY that file", () => {
    const g = readFileSync(resolve(root, "assets/line/generate-admin-menu.mjs"), "utf8");
    expect(g.match(/\.toFile\(/g)).toHaveLength(1);
    expect(g).toContain('const OUT = join(dirname(fileURLToPath(import.meta.url)), "menu-admin.png");');
  });
});
