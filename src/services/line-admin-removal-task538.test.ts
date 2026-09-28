// TASK-538 — remove admin rights from a LINE account. Pinned: super admin only (the ROOT app, real tokens) · the list names only
// what our data knows and says what it cannot · removal takes the ROLE off (the list), the menu falls back (coach / parent / the
// visitor default) and the sweep agrees · 🚫 no LINE message to the removed account · an unknown ref is a 404 · §2 unchanged.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { signToken } from "../lib/jwt";
import * as usersSvc from "./user.service";
import * as parentSvc from "./parent.service";
import * as richMenu from "../lib/line-rich-menu";
import * as lineLib from "../lib/line";
import * as lineClient from "../lib/line-client";
import * as linkSvc from "./line-admin-links.service";
import { NOT_KNOWN, adminRef, listLineAdmins, removeLineAdmin } from "./line-admin-links.service";
import { listMenuUsers } from "../lib/line-menu-users";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const src = (f: string) => code(readFileSync(resolve(root, f), "utf8"));
const spies: Array<{ mockRestore: () => void }> = [];
const origSkip = process.env.SKIP_AUTH;
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); if (origSkip === undefined) delete process.env.SKIP_AUTH; else process.env.SKIP_AUTH = origSkip; });

// Token-SHAPED LINE ids built here (no real ids): a coach who is also an admin, a parent who is, and one our data cannot name.
const U_COACH = "U" + "c0ac4".repeat(6) + "a1", U_MOM = "U" + "a0a0f".repeat(6) + "b2", U_X = "U" + "d3d3e".repeat(6) + "c3";

/** A fake `exec` over app_settings (the admin list), teachers and the family resolver; every write recorded. */
function world(ids: string[]) {
  const w = { ids: [...ids], writes: [] as unknown[] };
  const exec: any = {
    query: {
      appSettings: { findFirst: async () => ({ key: "line_admin_user_ids", value: w.ids }) },
      teachers: { findFirst: async () => undefined, findMany: async () => [] }, // each test says who (if anyone) is a coach
      parents: { findMany: async () => [] },
    },
    insert: () => ({ values: (v: any) => ({ onConflictDoUpdate: async () => { w.writes.push(v.value); w.ids = v.value; } }) }),
    select: () => ({ from: async () => [] }),
  };
  // the family seam: only U_MOM is a parent (a name AND a phone on the row — the name is what shows)
  spies.push(spyOn(parentSvc, "findParentByLineUserId").mockImplementation((async (id: string) => (id === U_MOM ? ({ id: "p1", name: "Khwan", phone: "0800000000" } as any) : null)) as any));
  return { w, exec };
}

describe("🔑 the list — only what our data can name, and it SAYS what it cannot", () => {
  test("each admin link: an opaque ref, the id's tail, the coach / parent behind it where WE know, and what removal falls back to — never the full id, never a display name", async () => {
    const { exec } = world([U_COACH, U_MOM, U_X]);
    // resolve the teacher per id: ask the family seam first (it records the id), then the teacher read sees it
    const out = await listLineAdmins({ ...exec, query: { ...exec.query, teachers: { findFirst: async () => undefined } } });
    expect(out.notKnown).toEqual(NOT_KNOWN);
    expect(out.admins.map((a) => a.idTail)).toEqual([`…${U_COACH.slice(-4)}`, `…${U_MOM.slice(-4)}`, `…${U_X.slice(-4)}`]);
    expect(out.admins.map((a) => a.ref)).toEqual([adminRef(U_COACH), adminRef(U_MOM), adminRef(U_X)]);
    expect(out.admins[1]).toMatchObject({ alsoParent: "Khwan", afterRemoval: "parent-menu" });
    expect(out.admins[2]).toMatchObject({ alsoTeacher: null, alsoParent: null, afterRemoval: "visitor-menu" }); // null = WE do not know
    const json = JSON.stringify(out);
    for (const id of [U_COACH, U_MOM, U_X]) expect(json).not.toContain(id);
    expect(json).not.toMatch(/displayName|linkedAt/);
  });
  test("a coach behind the id ⇒ named, and falls back to the TEACHER menu (teacher first — `detectLinkedRole`'s order)", async () => {
    const { exec } = world([U_COACH]);
    const out = await listLineAdmins({ ...exec, query: { ...exec.query, teachers: { findFirst: async () => ({ nickname: "Ek", name: "Ekachai" }) } } });
    expect(out.admins[0]).toMatchObject({ alsoTeacher: "Ek", afterRemoval: "teacher-menu" });
  });
});

describe("🔑 removal — the ROLE off the account, the menu falls back, the sweep agrees; 🚫 no message", () => {
  const noMessages = () => {
    const sent: string[] = [];
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async () => { sent.push("enqueueLine"); return {} as any; }) as any));
    for (const m of ["replyMessage", "pushMessage"] as const) if (typeof (lineClient as any)[m] === "function") spies.push(spyOn(lineClient as any, m).mockImplementation((async () => { sent.push(m); }) as any));
    return sent;
  };
  const menu = () => {
    const calls: unknown[][] = [];
    spies.push(spyOn(richMenu, "linkRoleRichMenu").mockImplementation((async (...a: unknown[]) => { calls.push(["link", ...a]); }) as any));
    spies.push(spyOn(richMenu, "unlinkRichMenuFromUser").mockImplementation((async (...a: unknown[]) => { calls.push(["unlink", ...a]); }) as any));
    return calls;
  };
  test("a pure admin (nobody we know) ⇒ off the list, the per-user link REMOVED (the visitor default applies), no message, the sweep does not list them", async () => {
    const { w, exec } = world([U_COACH, U_X]);
    const sent = noMessages(), calls = menu();
    const ex = { ...exec, query: { ...exec.query, teachers: { findFirst: async () => undefined } } };
    const out = await removeLineAdmin(adminRef(U_X), "admin-dong", ex);
    expect(out).toEqual({ removed: { ref: adminRef(U_X), idTail: `…${U_X.slice(-4)}` }, afterRemoval: "visitor-menu", menuSettled: true });
    expect(w.writes).toEqual([[U_COACH]]);
    expect(calls).toEqual([["unlink", U_X]]);
    expect(sent).toEqual([]);
    const swept = await listMenuUsers({ ...ex, query: { ...ex.query, teachers: { findMany: async () => [] }, parents: { findMany: async () => [] } }, select: () => ({ from: async () => [] }) });
    expect(swept.map((u) => u.lineUserId)).toEqual([U_COACH]); // the removed account is not expected to have ANY menu from us
  });
  test("a parent behind the id ⇒ the PARENT menu; a coach ⇒ the TEACHER menu — never left on the admin menu", async () => {
    for (const [id, teacher, want] of [[U_MOM, undefined, ["link", U_MOM, "customer"]], [U_COACH, { nickname: "Ek", name: "Ekachai" }, ["link", U_COACH, "teacher"]]] as const) {
      const { exec } = world([id]);
      noMessages();
      const calls = menu();
      await removeLineAdmin(adminRef(id), "admin-dong", { ...exec, query: { ...exec.query, teachers: { findFirst: async () => teacher } } });
      expect(calls).toEqual([[...want]]);
      expect(calls.some((c) => c[2] === "admin")).toBe(false);
      for (const s of spies.splice(0)) s.mockRestore();
    }
  });
  test("LINE refusing the menu call ⇒ STILL removed (the list write came first — notices stop), `menuSettled: false`, loud log", async () => {
    const { w, exec } = world([U_X]);
    noMessages();
    spies.push(spyOn(richMenu, "unlinkRichMenuFromUser").mockImplementation((async () => { throw new Error("LINE 500"); }) as any));
    const logs: string[] = [];
    spies.push(spyOn(console, "error").mockImplementation(((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }) as any));
    spies.push(spyOn(console, "info").mockImplementation((() => {}) as any));
    const out = await removeLineAdmin(adminRef(U_X), "a", { ...exec, query: { ...exec.query, teachers: { findFirst: async () => undefined } } });
    expect([w.writes, out.menuSettled]).toEqual([[[]], false]);
    expect(logs.join("\n")).toContain("🔴 [TASK-538] admin link");
  });
  test("an unknown ref ⇒ 404, and nothing written", async () => {
    const { w, exec } = world([U_X]);
    await expect(removeLineAdmin("0000000000000000", "a", exec)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(w.writes).toEqual([]);
  });
  test("by source: the removal file names no message sender at all", () => {
    const S = src("src/services/line-admin-links.service.ts");
    expect(S).not.toMatch(/enqueueLine|pushMessage|replyMessage|notifyAdmins|textReply/);
  });
});

describe("🔑 super admin ONLY — through the ROOT app, real tokens", () => {
  const ADMIN = "11111111-1111-4111-8111-111111111111", STAFF = "22222222-2222-4222-8222-222222222222";
  const rows: Record<string, any> = {
    [ADMIN]: { id: ADMIN, username: "boss", displayName: "Boss", isSuperAdmin: true, disabledAt: null, teacherId: null },
    [STAFF]: { id: STAFF, username: "kwan", displayName: "Kwan", isSuperAdmin: false, disabledAt: null, teacherId: null },
  };
  const call = async (id: string, method: string, path: string) => {
    process.env.SKIP_AUTH = "false";
    spies.push(spyOn(usersSvc, "findUserById").mockImplementation((async (x: string) => rows[x] ?? null) as any));
    spies.push(spyOn(usersSvc, "effectiveGrantKeys").mockImplementation((async () => ["menu:settings", "action:settings.edit"]) as any)); // grants do not open it
    const tok = await signToken({ sub: id, username: rows[id].username, role: "admin", isSuperAdmin: rows[id].isSuperAdmin });
    return rootApp.fetch(new Request(`http://localhost/api${path}`, { method, headers: { authorization: `Bearer ${tok}` } }));
  };
  test("a NON-super-admin (whatever their grants) ⇒ 403 on the list AND the removal — nothing read, nothing removed", async () => {
    const removed: string[] = [];
    spies.push(spyOn(richMenu, "unlinkRichMenuFromUser").mockImplementation((async (x: string) => { removed.push(x); }) as any));
    expect((await call(STAFF, "GET", "/users/line-admins")).status).toBe(403);
    expect((await call(STAFF, "DELETE", `/users/line-admins/${adminRef(U_X)}`)).status).toBe(403);
    expect(removed).toEqual([]);
  });
  test("a super admin ⇒ the list (200, with `notKnown`)", async () => {
    spies.push(spyOn(linkSvc, "listLineAdmins").mockImplementation((async () => ({ admins: [], notKnown: NOT_KNOWN })) as any)); // the gate is the subject here; the list's reads are pinned above
    const r = await call(ADMIN, "GET", "/users/line-admins");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ admins: [], notKnown: [...NOT_KNOWN] });
  });
  test("by source: the two routes live in the users group, behind its `requireSuperAdmin` — no action key", () => {
    const U = src("src/routes/users.ts");
    expect(U.indexOf('.use("*", requireSuperAdmin)')).toBeLessThan(U.indexOf('.get("/line-admins"'));
    expect(U).toContain('.delete("/line-admins/:ref", async (c) => c.json(await removeLineAdmin(c.req.param("ref"), actorOf(c))))');
  });
});

describe("🚫 what must not move", () => {
  test("SEC-1's gate · the admin link still settles the admin menu · teacher/parent linking · the account default · TASK-524's action", () => {
    const W = src("src/services/line-webhook.service.ts");
    expect(W).toContain('if (!checkAdminCode(lineUserId, code, process.env[ADMIN_CODE_ENV])) return { ok: false, message: (l) => t("verify_admin_bad", l) };');
    expect(W).toContain('if ((await detectLinkedRole(lineUserId)) === "admin") await settleAdminLink(lineUserId);');
    expect(W).toContain('if (role !== "admin") await settleLinkedRole(lineUserId, role);');
    expect(W).toContain('if (action === "admin") return doCallAdmin(lineUserId, replyToken, lang);');
    const M = src("src/lib/line-rich-menu.ts");
    expect(M).toContain("await setDefaultRichMenu(unknown);");
  });
});
