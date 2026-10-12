// TASK-725 (owner GO "ตามนั้น", shape 1) — the admin LINE link is tied to the WEB USER. By VALUE, no database: every function takes its executor, so a fake executor answers the
// reads and EVALUATES the real conditions (the `where` callbacks with fake operators; the writes' real SQL read back through drizzle). Pinned: ISSUE (hashed · 10 min · replaced ·
// refused for a coach / a disabled user) · LINK (once · expiry · THAT user · the miss limiter · another user's LINE · a re-link replaces) · UNLINK · the DTO never carries the LINE id ·
// the old panel (linked vs legacy) · the routes through the ROOT app · the migration. The SEC-1 / shared-code-retired pins live in `sec1-admin-code-task534.test.ts`.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ShopfrontRateLimit } from "../lib/shopfront-rate-limit";
import { ADMIN_CODE_MISS_LIMIT, ADMIN_CODE_WINDOW_MS } from "../lib/line-admin-code";
import { LINK_CODE_ALPHABET, LINK_CODE_LENGTH, LINK_CODE_TTL_MS, generateLinkCode, hashLinkCode, looksLikeLinkCode, normalizeLinkCode } from "../lib/line-link-code";
import { getAdminLineUserIds } from "../lib/line-admin";
import * as richMenu from "../lib/line-rich-menu";
import * as parentSvc from "./parent.service";
import * as linkSvc from "./admin-line-link.service";
import { issueLineLinkCode, isLineLinked, linkLineByCode } from "./admin-line-link.service";
import { adminRef, listLineAdmins, removeLineAdmin, unlinkLineOfUser } from "./line-admin-links.service";
import * as usersSvc from "./user.service";
import { toUserDTO } from "./user.service";
import { DEV_USER } from "../middleware/auth";
import { SCHEDULING_WITNESSES } from "../lib/migration-witness";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const dialect = new PgDialect();
const spies: Array<{ mockRestore: () => void }> = [];
const saved = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, saved); });
const silent = () => { for (const m of ["error", "warn", "info", "log"] as const) spies.push(spyOn(console, m).mockImplementation((() => {}) as any)); };

type UserRow = { id: string; username: string; displayName: string; lineUserId: string | null; teacherId: string | null; disabledAt: Date | null; lineLinkCodeHash: string | null; lineLinkCodeExpiresAt: Date | null };
const T0 = Date.parse("2026-10-11T12:00:00Z");
const cols = new Proxy({}, { get: (_t, k) => k });
const OPS = {
  eq: (c: string, v: unknown) => (r: any) => r[c] === v,
  ne: (c: string, v: unknown) => (r: any) => r[c] !== v,
  and: (...p: Array<(r: any) => boolean>) => (r: any) => p.every((f) => f(r)),
  isNotNull: (c: string) => (r: any) => r[c] != null,
  isNull: (c: string) => (r: any) => r[c] == null,
};

/** A world: the `users` table, the legacy admin list, and a fake executor over both. Every write is recorded. */
function world(users: Array<Partial<UserRow> & { id: string }> = [], legacy: string[] = []) {
  const w = {
    users: users.map((u) => ({ username: u.id, displayName: `Name ${u.id}`, lineUserId: null, teacherId: null, disabledAt: null, lineLinkCodeHash: null, lineLinkCodeExpiresAt: null, ...u }) as UserRow),
    legacy: [...legacy],
    legacyWrites: [] as string[][],
    failUpdates: 0,
    updates: 0,
  };
  const exec: any = {
    query: {
      users: {
        findFirst: async (q: any) => { const r = w.users.find(q.where(cols, OPS)); return r ? { ...r } : undefined; }, // a COPY, as a real database returns a snapshot
        findMany: async (q: any) => w.users.filter(q.where ? q.where(cols, OPS) : () => true).map((r) => ({ ...r })),
      },
      appSettings: { findFirst: async () => ({ key: "line_admin_user_ids", value: w.legacy }) },
      teachers: { findFirst: async () => undefined },
      parents: { findFirst: async () => undefined },
    },
    update: (table: any) => ({ set: (set: any) => ({ where: (cond: any) => {
      const run = (): Array<{ id: string }> => {
        if (getTableName(table) !== "users") throw new Error("unexpected update of " + getTableName(table));
        if (w.failUpdates > 0) { w.failUpdates--; const e: any = new Error("duplicate key"); e.code = "23505"; throw e; }
        w.updates++;
        const { sql, params } = dialect.sqlToQuery(cond);
        let i = 0;
        const id = params[i++];
        const hash = sql.includes(`"users"."line_link_code_hash" = $`) ? params[i++] : undefined;
        const exp = sql.includes(`"users"."line_link_code_expires_at" > $`) ? new Date(params[i++] as any).getTime() : undefined;
        const mustBeEnabled = sql.includes(`"users"."disabled_at" is null`);
        const hit = w.users.filter((u) => u.id === id && (hash === undefined || u.lineLinkCodeHash === hash) && (exp === undefined || (u.lineLinkCodeExpiresAt != null && u.lineLinkCodeExpiresAt.getTime() > exp)) && (!mustBeEnabled || u.disabledAt == null));
        for (const u of hit) Object.assign(u, set);
        return hit.map((u) => ({ id: u.id }));
      };
      return { then: (ok: any, ko: any) => Promise.resolve().then(run).then(() => undefined).then(ok, ko), returning: async () => run() };
    } }) }),
    insert: (table: any) => ({ values: (v: any) => ({ onConflictDoUpdate: async () => {
      if (getTableName(table) !== "app_settings") throw new Error("unexpected insert into " + getTableName(table));
      w.legacy = v.value; w.legacyWrites.push([...v.value]);
    } }) }),
  };
  return { w, exec };
}
const menuCalls = () => {
  const calls: unknown[][] = [];
  spies.push(spyOn(richMenu, "linkRoleRichMenu").mockImplementation((async (...a: unknown[]) => { calls.push(["link", ...a]); }) as any));
  spies.push(spyOn(richMenu, "unlinkRichMenuFromUser").mockImplementation((async (...a: unknown[]) => { calls.push(["unlink", ...a]); }) as any));
  spies.push(spyOn(parentSvc, "findParentByLineUserId").mockImplementation((async () => null) as any));
  return calls;
};
const freshLimit = () => new ShopfrontRateLimit({ windowMs: ADMIN_CODE_WINDOW_MS, missLimit: ADMIN_CODE_MISS_LIMIT, totalLimit: Number.POSITIVE_INFINITY });
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";

// ───────────────────────────────────────────── the code itself ─────────────────────────────────────────────
describe("the code: 8 unambiguous symbols, CSPRNG, typed forgivingly, hashed", () => {
  test("every generated code is 8 symbols from the alphabet that has NO `0 O 1 I L`", () => {
    expect(LINK_CODE_LENGTH).toBe(8);
    expect(LINK_CODE_ALPHABET).not.toMatch(/[01OIL]/);
    expect(new Set(LINK_CODE_ALPHABET).size).toBe(LINK_CODE_ALPHABET.length);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) { const c = generateLinkCode(); expect(looksLikeLinkCode(c)).toBe(true); seen.add(c); }
    expect(seen.size).toBeGreaterThan(1990); // not a constant or a tiny cycle (31^8 ≈ 8.5e11 codes)
  });
  test("normalising: case, spaces and hyphens ignored; anything else of the wrong shape is simply not a code", () => {
    expect(normalizeLinkCode(" k7m2-qx9p ")).toBe("K7M2QX9P");
    expect(looksLikeLinkCode(normalizeLinkCode("k7m2 qx9p"))).toBe(true);
    for (const bad of ["", "K7M2QX9", "K7M2QX9PP", "K7M2QX90", "K7M2QXIP", "229"]) expect(looksLikeLinkCode(normalizeLinkCode(bad))).toBe(false);
  });
  test("the hash is SHA-256 hex of the NORMALISED code (so `k7m2-qx9p` and `K7M2QX9P` meet the same row), and it is not the code", () => {
    expect(hashLinkCode("K7M2QX9P")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLinkCode(normalizeLinkCode("k7m2-qx9p"))).toBe(hashLinkCode("K7M2QX9P"));
    expect(hashLinkCode("K7M2QX9P")).not.toContain("K7M2QX9P");
  });
});

// ───────────────────────────────────────────── ISSUE ─────────────────────────────────────────────
describe("🔑 ISSUE — one code per user, hashed, 10 minutes", () => {
  test("returns the PLAIN code once, with its expiry; stores ONLY the hash and the expiry; tied to THIS user", async () => {
    const { w, exec } = world([{ id: A }, { id: B }]);
    const r = await issueLineLinkCode(A, exec, T0);
    expect(r).toEqual({ code: r.code, expiresAt: new Date(T0 + LINK_CODE_TTL_MS).toISOString(), expiresInSeconds: 600 });
    expect(looksLikeLinkCode(r.code)).toBe(true);
    const [ua, ub] = [w.users[0]!, w.users[1]!];
    expect(ua.lineLinkCodeHash).toBe(hashLinkCode(r.code));
    expect(ua.lineLinkCodeExpiresAt!.getTime()).toBe(T0 + 600_000);
    expect(JSON.stringify(w.users)).not.toContain(r.code); // 🔴 the plain code is nowhere in the table
    expect(ub.lineLinkCodeHash).toBeNull(); // another user is untouched
  });
  test("a NEW code replaces the old one: one live code per user, and the old code no longer works", async () => {
    silent();
    const { w, exec } = world([{ id: A }]);
    const first = await issueLineLinkCode(A, exec, T0);
    const second = await issueLineLinkCode(A, exec, T0 + 1_000);
    expect(second.code).not.toBe(first.code);
    expect(w.users[0]!.lineLinkCodeHash).toBe(hashLinkCode(second.code));
    expect((await linkLineByCode("Uold", first.code, { exec, now: T0 + 2_000, limit: freshLimit() })).ok).toBe(false);
    expect((await linkLineByCode("Unew", second.code, { exec, now: T0 + 2_000, limit: freshLimit() })).ok).toBe(true);
  });
  test("a COACH account (users.teacher_id set) ⇒ 403 LINE_LINK_NOT_FOR_COACH; a DISABLED user ⇒ 403 USER_DISABLED; an unknown user ⇒ 404 — and nothing is written", async () => {
    const { w, exec } = world([{ id: A, teacherId: "t1" }, { id: B, disabledAt: new Date(T0) }]);
    await expect(issueLineLinkCode(A, exec, T0)).rejects.toMatchObject({ status: 403, code: "LINE_LINK_NOT_FOR_COACH" });
    await expect(issueLineLinkCode(B, exec, T0)).rejects.toMatchObject({ status: 403, code: "USER_DISABLED" });
    await expect(issueLineLinkCode(C, exec, T0)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(w.updates).toBe(0);
  });
  test("a hash that collides with another user's live code is drawn again (23505 ⇒ retry); five collisions in a row ⇒ a loud 500, never a silent success", async () => {
    const { w, exec } = world([{ id: A }]);
    w.failUpdates = 2;
    const r = await issueLineLinkCode(A, exec, T0);
    expect(w.users[0]!.lineLinkCodeHash).toBe(hashLinkCode(r.code));
    w.failUpdates = 5;
    await expect(issueLineLinkCode(A, exec, T0)).rejects.toMatchObject({ status: 500 });
  });
  test("🔴 pinned by source: the plain code is returned by the issue function and by NOTHING that stores or logs it", () => {
    const S = read("src/services/admin-line-link.service.ts").replace(/^\s*\/\/.*$/gm, "");
    const body = S.slice(S.indexOf("export async function issueLineLinkCode("), S.indexOf("export type LinkResult"));
    expect(body).toContain("lineLinkCodeHash: hashLinkCode(code)");
    expect(body).not.toMatch(/console\./);
    expect(body).not.toMatch(/lineLinkCode:\s*code|lineLinkCodePlain/);
  });
});

// ───────────────────────────────────────────── LINK ─────────────────────────────────────────────
describe("🔑 LINK — typed in the OA chat", () => {
  test("a live code links THAT user's `line_user_id` and is burned in the same statement; it works once, within 10 minutes", async () => {
    silent();
    const { w, exec } = world([{ id: A }]);
    const { code } = await issueLineLinkCode(A, exec, T0);
    const r = await linkLineByCode("Uline-a", code, { exec, now: T0 + 599_000, limit: freshLimit() });
    expect(r).toEqual({ ok: true, userId: A });
    expect(w.users[0]).toMatchObject({ lineUserId: "Uline-a", lineLinkCodeHash: null, lineLinkCodeExpiresAt: null });
    expect((await linkLineByCode("Uline-b", code, { exec, now: T0 + 600_000, limit: freshLimit() })).ok).toBe(false); // reuse refused
    expect(w.users[0]!.lineUserId).toBe("Uline-a");
  });
  test("expiry: at the exact expiry instant the code is already dead, and nothing is written", async () => {
    silent();
    const { w, exec } = world([{ id: A }]);
    const { code } = await issueLineLinkCode(A, exec, T0);
    const r = await linkLineByCode("Ux", code, { exec, now: T0 + LINK_CODE_TTL_MS, limit: freshLimit() });
    expect(r).toEqual({ ok: false, reason: "expired" });
    expect(w.users[0]!.lineUserId).toBeNull();
    expect(w.users[0]!.lineLinkCodeHash).toBe(hashLinkCode(code)); // not burned by a refusal
  });
  test("another user's code links THAT user, not the one who happens to be typing", async () => {
    silent();
    const { w, exec } = world([{ id: A }, { id: B }]);
    await issueLineLinkCode(A, exec, T0);
    const codeB = (await issueLineLinkCode(B, exec, T0)).code;
    expect(await linkLineByCode("Uchat", codeB, { exec, now: T0 + 1_000, limit: freshLimit() })).toEqual({ ok: true, userId: B });
    expect(w.users.map((u) => u.lineUserId)).toEqual([null, "Uchat"]);
  });
  test("typing is forgiving: lower case + spaces + a hyphen link; one wrong character does not", async () => {
    silent();
    const { w, exec } = world([{ id: A }]);
    const { code } = await issueLineLinkCode(A, exec, T0);
    const wrong = code.slice(0, 7) + (code[7] === "2" ? "3" : "2");
    expect((await linkLineByCode("Ux", wrong, { exec, now: T0 + 1, limit: freshLimit() })).ok).toBe(false);
    expect((await linkLineByCode("Ux", ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()} `, { exec, now: T0 + 2, limit: freshLimit() })).ok).toBe(true);
    expect(w.users[0]!.lineUserId).toBe("Ux");
  });
  test("refused, and the reason is for the LOG only: a disabled user · a coach account · this LINE account is another user's · not shaped like a code", async () => {
    silent();
    const { w, exec } = world([{ id: A }, { id: B }, { id: C, lineUserId: "Uchat" }]);
    const codeA = (await issueLineLinkCode(A, exec, T0)).code;
    w.users[0]!.disabledAt = new Date(T0);
    expect(await linkLineByCode("Ux", codeA, { exec, now: T0 + 1, limit: freshLimit() })).toEqual({ ok: false, reason: "the user is disabled" });
    w.users[0]!.disabledAt = null; w.users[0]!.teacherId = "t1";
    expect(await linkLineByCode("Ux", codeA, { exec, now: T0 + 1, limit: freshLimit() })).toEqual({ ok: false, reason: "a coach account" });
    w.users[0]!.teacherId = null;
    expect(await linkLineByCode("Uchat", codeA, { exec, now: T0 + 1, limit: freshLimit() })).toEqual({ ok: false, reason: "this LINE account is already linked to another user" });
    expect(await linkLineByCode("Ux", "nope", { exec, now: T0 + 1, limit: freshLimit() })).toEqual({ ok: false, reason: "not shaped like a code" });
    expect(w.users.map((u) => u.lineUserId)).toEqual([null, null, "Uchat"]);
  });
  test(`the miss limiter still bites: ${ADMIN_CODE_MISS_LIMIT} misses, then even the RIGHT code is refused WITHOUT a lookup; another account is unaffected; the window lets them back`, async () => {
    silent();
    const { w, exec } = world([{ id: A }]);
    const { code } = await issueLineLinkCode(A, exec, T0);
    const limit = freshLimit();
    for (let i = 0; i < ADMIN_CODE_MISS_LIMIT; i++) await linkLineByCode("Ua", "ZZZZZZZZ", { exec, now: T0, limit });
    expect(await linkLineByCode("Ua", code, { exec, now: T0 + 1, limit })).toEqual({ ok: false, reason: "over the miss limit" });
    expect(w.users[0]!.lineUserId).toBeNull();
    expect((await linkLineByCode("Ub", code, { exec, now: T0 + 2, limit })).ok).toBe(true); // a different LINE account
    const again = world([{ id: A }]);
    const c2 = (await issueLineLinkCode(A, again.exec, T0)).code;
    for (let i = 0; i < ADMIN_CODE_MISS_LIMIT; i++) await linkLineByCode("Ua", "ZZZZZZZZ", { exec: again.exec, now: T0, limit });
    expect((await linkLineByCode("Ua", c2, { exec: again.exec, now: T0 + ADMIN_CODE_WINDOW_MS + 1, limit })).ok).toBe(false); // the code itself is long dead by then…
  });
  test("🔑 a RE-LINK replaces the user's earlier LINE account: it stops being an admin (a legacy copy goes too) and its menu is settled", async () => {
    silent();
    const calls = menuCalls();
    const { w, exec } = world([{ id: A, lineUserId: "Uold" }], ["Uold", "Uother"]);
    const { code } = await issueLineLinkCode(A, exec, T0);
    expect(await linkLineByCode("Unew", code, { exec, now: T0 + 1, limit: freshLimit() })).toEqual({ ok: true, userId: A });
    expect(w.users[0]!.lineUserId).toBe("Unew");
    expect(w.legacy).toEqual(["Uother"]);
    expect(calls).toEqual([["unlink", "Uold"]]);
    expect(await getAdminLineUserIds(exec)).toEqual(["Uother", "Unew"]);
  });
});

// ───────────────────────────────────────────── UNLINK + the panel ─────────────────────────────────────────────
describe("🔑 UNLINK and the old panel", () => {
  test("Unlink clears the link and any pending code, drops the legacy copy, settles the menu — and the user is no longer a recipient", async () => {
    silent();
    const calls = menuCalls();
    const { w, exec } = world([{ id: A, lineUserId: "Uline", lineLinkCodeHash: "h", lineLinkCodeExpiresAt: new Date(T0 + 1000) }], ["Uline", "Uother"]);
    expect(await getAdminLineUserIds(exec)).toEqual(["Uline", "Uother"]);
    expect(await unlinkLineOfUser(A, "boss", exec)).toEqual({ lineUserId: "Uline", afterRemoval: "visitor-menu", menuSettled: true });
    expect(w.users[0]).toMatchObject({ lineUserId: null, lineLinkCodeHash: null, lineLinkCodeExpiresAt: null });
    expect(w.legacy).toEqual(["Uother"]);
    expect(calls).toEqual([["unlink", "Uline"]]);
    expect(await getAdminLineUserIds(exec)).toEqual(["Uother"]);
  });
  test("idempotent: nothing linked ⇒ nothing written, `afterRemoval: none`; an unknown user ⇒ 404", async () => {
    silent();
    const { w, exec } = world([{ id: A }]);
    expect(await unlinkLineOfUser(A, "boss", exec)).toEqual({ lineUserId: null, afterRemoval: "none", menuSettled: true });
    expect(w.updates).toBe(0);
    await expect(unlinkLineOfUser(B, "boss", exec)).rejects.toMatchObject({ status: 404 });
  });
  test("the panel: a LINKED account is shown by the WEB USER's display name (and `disabled`), a legacy bare id is marked legacy; an id in both is shown ONCE, as linked — never the LINE id", async () => {
    silent();
    menuCalls();
    const { exec } = world([{ id: A, displayName: "Khun Dong", username: "dong", lineUserId: "Uaaaa1111" }, { id: B, displayName: "Khun Off", username: "off", lineUserId: "Ubbbb2222", disabledAt: new Date(T0) }], ["Ulegacy3333", "Uaaaa1111"]);
    const out = await listLineAdmins(exec);
    expect(out.admins.map((a) => [a.kind, a.displayName, a.username, a.userId, a.disabled, a.idTail])).toEqual([
      ["linked", "Khun Dong", "dong", A, false, "…1111"],
      ["linked", "Khun Off", "off", B, true, "…2222"],
      ["legacy", null, null, null, false, "…3333"],
    ]);
    expect(out.admins.map((a) => a.ref)).toEqual([adminRef("Uaaaa1111"), adminRef("Ubbbb2222"), adminRef("Ulegacy3333")]);
    const json = JSON.stringify(out);
    for (const id of ["Uaaaa1111", "Ubbbb2222", "Ulegacy3333"]) expect(json).not.toContain(id);
  });
  test("removing a LINKED entry by its ref UNLINKS that user (the legacy copy of the same id goes too); a legacy ref leaves the old list; an unknown ref ⇒ 404 and nothing written", async () => {
    silent();
    const calls = menuCalls();
    const { w, exec } = world([{ id: A, lineUserId: "Uaaaa1111" }], ["Ulegacy3333", "Uaaaa1111"]);
    const r1 = await removeLineAdmin(adminRef("Uaaaa1111"), "boss", exec);
    expect(r1).toEqual({ removed: { ref: adminRef("Uaaaa1111"), idTail: "…1111" }, afterRemoval: "visitor-menu", menuSettled: true });
    expect(w.users[0]!.lineUserId).toBeNull();
    expect(w.legacy).toEqual(["Ulegacy3333"]);
    await removeLineAdmin(adminRef("Ulegacy3333"), "boss", exec);
    expect(w.legacy).toEqual([]);
    expect(calls).toEqual([["unlink", "Uaaaa1111"], ["unlink", "Ulegacy3333"]]);
    const writes = w.legacyWrites.length;
    await expect(removeLineAdmin("0000000000000000", "boss", exec)).rejects.toMatchObject({ status: 404 });
    expect(w.legacyWrites.length).toBe(writes);
  });
  test("🔴 a removal never copies a LINKED user's id into the legacy list (the remover reads the legacy list only)", async () => {
    silent();
    menuCalls();
    const { w, exec } = world([{ id: A, lineUserId: "Ulinked" }], ["Ulegacy", "Ugone"]);
    await removeLineAdmin(adminRef("Ugone"), "boss", exec);
    expect(w.legacyWrites).toEqual([["Ulegacy"]]);
  });
});

// ───────────────────────────────────────────── the DTO never carries the LINE id ─────────────────────────────────────────────
describe("🔴 the DTO: `lineLinked` is a BOOLEAN — the LINE id, the code and its hash never leave the server", () => {
  const base = { id: "u", username: "a", displayName: "A", isSuperAdmin: false, disabledAt: null, createdAt: "2026-10-11T00:00:00Z" };
  test("linked / not linked ⇒ true / false, and the raw id is nowhere in the serialised DTO", () => {
    const linked = toUserDTO({ ...base, lineUserId: "Usecret123456", lineLinkCodeHash: "deadbeef", passwordHash: "x" } as any);
    const bare = toUserDTO({ ...base, lineUserId: null } as any);
    expect([linked.lineLinked, bare.lineLinked]).toEqual([true, false]);
    const json = JSON.stringify(linked);
    for (const leak of ["Usecret123456", "deadbeef", "lineUserId", "lineLinkCode", "passwordHash"]) expect(json).not.toContain(leak);
  });
  test("by source: `lineUserId` is read in `toUserDTO` ONLY to answer the boolean", () => {
    const S = read("src/services/user.service.ts");
    const dto = S.slice(S.indexOf("export const toUserDTO"), S.indexOf("export const hashPassword"));
    expect(dto).toContain("lineLinked: !!u.lineUserId,");
    expect((dto.match(/lineUserId/g) ?? []).length).toBe(2); // the input type, and the boolean
  });
});

// ───────────────────────────────────────────── the routes, through the ROOT app ─────────────────────────────────────────────
describe("🔑 the routes (root app, services spied)", () => {
  const call = (method: string, path: string, body?: unknown) => rootApp.fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  test("POST /me/line-link-code ⇒ 200 { code, expiresAt, expiresInSeconds } for THE SIGNED-IN user (the token's id, never a parameter)", async () => {
    process.env.SKIP_AUTH = "true";
    const asked: unknown[] = [];
    spies.push(spyOn(linkSvc, "issueLineLinkCode").mockImplementation((async (id: string) => { asked.push(id); return { code: "K7M2QX9P", expiresAt: "2026-10-11T12:10:00.000Z", expiresInSeconds: 600 }; }) as any));
    const r = await call("POST", "/me/line-link-code");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ code: "K7M2QX9P", expiresAt: "2026-10-11T12:10:00.000Z", expiresInSeconds: 600 });
    expect(asked).toEqual([DEV_USER.id]);
  });
  test("a refusal reaches the screen as the standard envelope: coach ⇒ 403 LINE_LINK_NOT_FOR_COACH", async () => {
    process.env.SKIP_AUTH = "true";
    spies.push(spyOn(linkSvc, "issueLineLinkCode").mockImplementation((async () => { throw linkSvc.LINE_LINK_NOT_FOR_COACH(); }) as any));
    const r = await call("POST", "/me/line-link-code");
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe("LINE_LINK_NOT_FOR_COACH");
  });
  test("GET /me/line-link ⇒ { lineLinked } — and 🔑 `GET /me` is UNCHANGED (no `lineLinked`, no extra read on the shell's hot path)", async () => {
    process.env.SKIP_AUTH = "true";
    spies.push(spyOn(linkSvc, "isLineLinked").mockImplementation((async () => true) as any));
    const a = await call("GET", "/me/line-link");
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ lineLinked: true });
    const me = await call("GET", "/me");
    expect(me.status).toBe(200);
    expect(Object.keys(((await me.json()) as any).user).sort()).toEqual(["actions", "displayName", "id", "isSuperAdmin", "menus", "roleName", "teacherId", "username"]);
  });
  test("DELETE /users/:id/line-link — SUPER ADMIN only: a non-super-admin ⇒ 403 and the service is never called; a super admin ⇒ 200 { user, afterRemoval, menuSettled }", async () => {
    process.env.SKIP_AUTH = "true";
    const asked: unknown[][] = [];
    spies.push(spyOn(usersSvc, "unlinkUserLine").mockImplementation((async (...a: unknown[]) => { asked.push(a); return { user: { id: A, lineLinked: false }, afterRemoval: "visitor-menu", menuSettled: true }; }) as any));
    Object.assign(DEV_USER as any, { isSuperAdmin: false, grants: new Set(["menu:settings", "action:settings.edit"]) });
    expect((await call("DELETE", `/users/${A}/line-link`)).status).toBe(403);
    expect(asked).toEqual([]);
    Object.assign(DEV_USER as any, { isSuperAdmin: true });
    const r = await call("DELETE", `/users/${A}/line-link`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ user: { id: A, lineLinked: false }, afterRemoval: "visitor-menu", menuSettled: true });
    expect(asked.length).toBe(1);
    expect(asked[0]![0]).toBe(A);
    expect((await call("DELETE", `/users/not-a-uuid/line-link`)).status).toBe(400); // the global uuid guard
  });
  test("by source: the new `/me` and `/users` routes are exactly these three, in their own groups (which carry their own guards)", () => {
    const M = read("src/routes/me.ts"), U = read("src/routes/users.ts");
    expect(M).toContain('.post("/line-link-code", async (c) => c.json(await issueLineLinkCode(c.get("user").id)))');
    expect(M).toContain('.get("/line-link", async (c) => c.json({ lineLinked: await isLineLinked(c.get("user").id) }))');
    expect(U).toContain('.delete("/:id/line-link", async (c) => c.json(await usersSvc.unlinkUserLine(c.req.param("id"), actorOf(c))))');
    expect(U.indexOf('.use("*", requireSuperAdmin)')).toBeLessThan(U.indexOf('.delete("/:id/line-link"'));
  });
  test("`isLineLinked` is a boolean read of one column", async () => {
    const { exec } = world([{ id: A, lineUserId: "Ux" }, { id: B }]);
    expect([await isLineLinked(A, exec), await isLineLinked(B, exec), await isLineLinked(C, exec)]).toEqual([true, false, false]);
  });
});

// ───────────────────────────────────────────── the migration ─────────────────────────────────────────────
describe("🔴 the migration `0067` — three nullable columns, two PARTIAL unique indexes, the code-hash index LAST = the witness; no data written", () => {
  const SQL = read("drizzle/0067_users_line_link.sql");
  const body = SQL.replace(/^--.*$/gm, "");
  test("exactly the columns and indexes, every statement IF NOT EXISTS, and NO data statement", () => {
    expect(body).toContain('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "line_user_id" text;');
    expect(body).toContain('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "line_link_code_hash" text;');
    expect(body).toContain('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "line_link_code_expires_at" timestamp with time zone;');
    expect(body).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "users_line_user_id_uq" ON "users" USING btree ("line_user_id") WHERE "line_user_id" is not null;');
    expect(body).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "users_line_link_code_hash_uq" ON "users" USING btree ("line_link_code_hash") WHERE "line_link_code_hash" is not null;');
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/i);
    const statements = body.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
    expect(statements.length).toBe(5);
    for (const s of statements) expect(s).toMatch(/IF NOT EXISTS/);
    expect(statements.at(-1)).toContain("users_line_link_code_hash_uq"); // the LAST object is the witness
  });
  test("journal + witness registered: idx 67, the code-hash index is the probe, rerunnable; the schema carries the same columns and indexes", () => {
    const J = JSON.parse(read("drizzle/meta/_journal.json"));
    expect(J.entries.find((e: any) => e.idx === 67)).toMatchObject({ idx: 67, tag: "0067_users_line_link", breakpoints: true }); // 🔻 TASK-732: by idx / tag, not .at(-1) (0068 is the last now)
    expect(SCHEDULING_WITNESSES.find((w: any) => w.tag === "0067_users_line_link")).toMatchObject({ tag: "0067_users_line_link", probe: { kind: "index", index: "users_line_link_code_hash_uq" }, rerunnable: true });
    const schema = read("src/db/schema.ts");
    expect(schema).toContain('lineUserId: text("line_user_id"),');
    expect(schema).toContain('lineLinkCodeHash: text("line_link_code_hash"),');
    expect(schema).toContain('lineLinkCodeExpiresAt: timestamp("line_link_code_expires_at", { withTimezone: true }),');
    expect(schema).toContain('uniqueIndex("users_line_user_id_uq").on(t.lineUserId).where(sql`${t.lineUserId} is not null`)');
    expect(schema).toContain('uniqueIndex("users_line_link_code_hash_uq").on(t.lineLinkCodeHash).where(sql`${t.lineLinkCodeHash} is not null`)');
  });
});
