// 🔴🔴 TASK-534 (SEC-1) → TASK-725 — the bot printed the admin code as an EXAMPLE (`(เช่น 229)`) and the check defaulted to that value, so any follower could
// link as an admin and receive every family's leave notices. TASK-534 closed it for ONE shared code; TASK-725 RETIRED the shared code altogether: a LINE account becomes
// an admin only by typing the ONE-TIME code a signed-in web user asked for. What is pinned here, and why each still holds:
//   1 · no example in any secret prompt (a RULE over every chat string)                                  — unchanged
//   2 · 🔴 item 8, NO FALLBACK EVER: nothing reads the shared code's env key, with it SET or UNSET no typed value links anybody, and no value written in the repo works as a code
//   3 · every refusal the SAME reply, nothing about the code in the chat or the log                       — now for wrong · expired · used · disabled · another user's LINE · over the limit
//   4 · a per-LINE-user miss limit that the un-mute cannot reset                                         — unchanged in spirit
// Through the REAL dispatcher, over an in-memory `line_link_sessions` row (the TASK-520 harness shape) and an in-memory `users` table.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { db } from "../db";
import { handleLineWebhookEvents } from "./line-webhook.service";
import * as registerSvc from "./line-register.service";
import * as lineClient from "../lib/line-client";
import * as codeModule from "../lib/line-admin-code";
import { ADMIN_CODE_MISS_LIMIT, ADMIN_CODE_WINDOW_MS, adminLinkBlocked, recordAdminLinkAttempt } from "../lib/line-admin-code";
import { allChatStrings, t } from "../lib/line-i18n";
import { LINK_CODE_TTL_MS, generateLinkCode, hashLinkCode } from "../lib/line-link-code";
import { SHOPFRONT_MISS_LIMIT, SHOPFRONT_TOTAL_LIMIT, SHOPFRONT_WINDOW_MS, ShopfrontRateLimit, shopfrontRateLimit } from "../lib/shopfront-rate-limit";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const dialect = new PgDialect();
const spies: Array<{ mockRestore: () => void }> = [];
const ENV = "LINE_ADMIN_VERIFY_CODE"; // the retired shared code's env key — NAMED here (Porter allows that), its value is never written anywhere
const saved = process.env[ENV];
// A throwaway in-process value for the "env SET" case, built at runtime: never a literal credential in the repo (the workspace rule).
const SHARED_VALUE = ["k7", "Qm", "2x", "9p"].join("");
const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  for (const m of ["error", "warn", "info", "log"] as const) spies.push(spyOn(console, m).mockImplementation(((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }) as any));
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
});

// ── an in-memory `users` table, answering the REAL `where` callbacks our code passes (evaluated with fake operators) ──
type UserRow = { id: string; lineUserId: string | null; teacherId: string | null; disabledAt: Date | null; lineLinkCodeHash: string | null; lineLinkCodeExpiresAt: Date | null };
let USERS: UserRow[] = [];
const cols = new Proxy({}, { get: (_t, k) => k });
const OPS = {
  eq: (c: string, v: unknown) => (r: any) => r[c] === v,
  ne: (c: string, v: unknown) => (r: any) => r[c] !== v,
  and: (...p: Array<(r: any) => boolean>) => (r: any) => p.every((f) => f(r)),
  isNotNull: (c: string) => (r: any) => r[c] != null,
  isNull: (c: string) => (r: any) => r[c] == null,
};
let userSeq = 0;
/** A web user holding a LIVE one-time code; returns the user and the PLAIN code (which only the test ever sees). */
function userWithCode(over: Partial<UserRow> = {}, ttlMs = LINK_CODE_TTL_MS) {
  const plain = generateLinkCode();
  const u: UserRow = { id: `00000000-0000-4000-8000-${String(++userSeq).padStart(12, "0")}`, lineUserId: null, teacherId: null, disabledAt: null, lineLinkCodeHash: hashLinkCode(plain), lineLinkCodeExpiresAt: new Date(Date.now() + ttlMs), ...over };
  USERS.push(u);
  return { u, plain };
}

type Row = { lineUserId: string; step: string; pendingRole: string | null; draft: unknown; unexpectedCount: number; mutedUntil: Date | null; updatedAt: Date };
let seq = 0;
/** A fresh chat at the admin code step (a fresh LINE user each time, so the module's miss limit is per-test). */
function world(userId = `Uadm${++seq}sec1`) {
  const s: Row = { lineUserId: userId, step: "AWAIT_CODE", pendingRole: "admin", draft: null, unexpectedCount: 0, mutedUntil: null, updatedAt: new Date() };
  const replies: string[] = [];
  const settled: string[] = [];
  const settingsWrites: unknown[] = [];
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => ({ ...s })) as any));
  spies.push(spyOn(db.query.users, "findFirst").mockImplementation((async (q: any) => { const r = USERS.find(q.where(cols, OPS)); return r ? { ...r } : undefined; }) as any)); // a COPY, as a real database returns a snapshot
  spies.push(spyOn(db.query.users, "findMany").mockImplementation((async (q: any) => USERS.filter(q.where(cols, OPS)).map((r) => ({ lineUserId: r.lineUserId }))) as any));
  spies.push(spyOn(db, "update").mockImplementation(((table: any) => ({ set: (set: any) => ({ where: (cond: any) => {
    const run = (): Array<{ id: string }> => {
      const name = getTableName(table);
      const { sql, params } = dialect.sqlToQuery(cond);
      if (name === "line_link_sessions") {
        if (sql.includes(`"line_link_sessions"."line_user_id" = $1`) && params[0] === s.lineUserId) Object.assign(s, set);
        return [];
      }
      if (name === "users") {
        // THE REAL CONDITION — burn and link in ONE statement: id · the hash · not expired · not disabled
        for (const part of [`"users"."id" = $1`, `"users"."line_link_code_hash" = $2`, `"users"."line_link_code_expires_at" > $3`, `"users"."disabled_at" is null`]) expect(sql).toContain(part);
        const hit = USERS.filter((u) => u.id === params[0] && u.lineLinkCodeHash === params[1] && u.lineLinkCodeExpiresAt != null && u.lineLinkCodeExpiresAt.getTime() > new Date(params[2] as any).getTime() && u.disabledAt == null);
        for (const u of hit) Object.assign(u, set);
        return hit.map((u) => ({ id: u.id }));
      }
      return [];
    };
    const p: any = { then: (ok: any, ko: any) => Promise.resolve(run()).then(() => undefined).then(ok, ko), returning: async () => run() };
    return p;
  } }) })) as any));
  spies.push(spyOn(db, "insert").mockImplementation(((table: any) => ({ values: (v: any) => {
    if (getTableName(table) === "app_settings") settingsWrites.push(v);
    return { onConflictDoUpdate: async () => {}, onConflictDoNothing: async () => {} };
  } })) as any));
  spies.push(spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })) as any));
  spies.push(spyOn(db, "delete").mockImplementation((() => ({ where: async () => { s.step = "CLEARED"; } })) as any)); // `clearSession` after a link
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(registerSvc, "settleAdminLink").mockImplementation((async (id: string) => { settled.push(id); }) as any));
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { for (const x of m) replies.push(x.text); }) as any));
  const say = (text: string) => handleLineWebhookEvents([{ type: "message", replyToken: "rt", source: { userId }, message: { type: "text", text } } as any]);
  const snapshot = () => JSON.stringify(USERS);
  return { s, replies, settled, settingsWrites, say, userId, snapshot };
}

describe("1️⃣ the prompt — no example, and it is a RULE over every chat string (TASK-479's shape)", () => {
  test("`code_admin` now asks, and shows nothing", () => {
    expect([t("code_admin", "TH"), t("code_admin", "EN")]).toEqual(["กรุณาพิมพ์รหัสแอดมิน", "Please type the admin code"]);
  });
  test("🔑 no chat string that asks for a secret (code · password · PIN · OTP) carries an example (เช่น · e.g. · ตัวอย่าง · example)", () => {
    const secret = /รหัส|\bcode\b|password|\bPIN\b|\bOTP\b/i, example = /เช่น|e\.g\.|ตัวอย่าง|\bexample\b/i;
    const all = allChatStrings();
    expect(all.length).toBeGreaterThan(200); // the whole table, not a sample
    expect(all.some(([k]) => k === "code_admin")).toBe(true);
    const hits = all.flatMap(([k, th, en]) => [th, en].filter((x) => secret.test(x) && example.test(x)).map(() => k));
    expect(hits).toEqual([]);
  });
  test("…and the retired code appears in NO chat string, anywhere", () => {
    expect(allChatStrings().filter(([, th, en]) => /(^|\D)229(\D|$)/.test(th + " " + en)).map(([k]) => k)).toEqual([]);
  });
});

describe("2️⃣ 🔴 THE SHARED CODE IS RETIRED — no default, NO FALLBACK, EVER (TASK-725 item 8)", () => {
  test("the gate module exports ONLY the limiter and its two helpers: no config reader, no comparison, no env name, no 'retired values' list", () => {
    expect(Object.keys(codeModule).sort()).toEqual(["ADMIN_CODE_MISS_LIMIT", "ADMIN_CODE_WINDOW_MS", "adminCodeLimit", "adminLinkBlocked", "recordAdminLinkAttempt"]);
  });
  test("🔑 derived from the source: NO product file reads the shared code's env key (a fallback anywhere would have to be here)", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
    const SRC = resolve(root, "src");
    const product = walk(SRC).filter((p) => p.endsWith(".ts") && !/\.(test|mutations)\.ts$/.test(p)).map((p) => relative(SRC, p).split("\\").join("/"));
    expect(product.length).toBeGreaterThan(100); // the sweep cannot go quietly vacuous
    expect(product).toContain("services/line-webhook.service.ts");
    const readers = product.filter((rel) => new RegExp(`${ENV}|ADMIN_CODE_ENV`).test(code(readFileSync(join(SRC, rel), "utf8"))));
    expect(readers).toEqual([]);
  });
  test("by value, env SET to a strong value: typing EXACTLY that value links nobody and writes nothing — the old path is gone", async () => {
    process.env[ENV] = SHARED_VALUE;
    const { plain } = userWithCode(); // a real web user HAS a live code; the shared value is simply not it
    const before = JSON.stringify(USERS);
    const w = world();
    await w.say(SHARED_VALUE);
    expect(w.replies.join("\n")).toContain(t("verify_admin_bad", "TH"));
    expect(w.replies.join("\n")).not.toContain(t("verify_admin_ok", "TH"));
    expect(JSON.stringify(USERS)).toBe(before);
    expect(w.settingsWrites).toEqual([]); // nothing ever lands in `app_settings.line_admin_user_ids` any more
    expect(w.settled).toEqual([]);
    expect(plain).not.toBe(SHARED_VALUE);
  });
  test("by value, env UNSET: no typed value links anybody — not the retired `229`, not a short or a code-shaped guess, not blank", async () => {
    delete process.env[ENV];
    userWithCode();
    const before = JSON.stringify(USERS);
    for (const typed of ["229", "12345678", "ADMINCODE", "23456789", "ABCD-EFGH", "k7Qm2x9p"]) {
      const w = world();
      await w.say(typed);
      expect(w.replies.join("\n")).toContain(t("verify_admin_bad", "TH"));
      expect(JSON.stringify(USERS)).toBe(before);
      expect(w.settingsWrites).toEqual([]);
      expect(w.settled).toEqual([]);
    }
    // a blank message is ignored by the dispatcher before the admin branch is reached (no reply at all) — and still links nobody
    const blank = world();
    await blank.say("   ");
    expect(JSON.stringify(USERS)).toBe(before);
    expect(blank.settingsWrites).toEqual([]);
    expect(blank.settled).toEqual([]);
  });
  test("🔴 no default anywhere: `229` is gone from the service, the admin branch reads no environment value, and `.env.example` is EMPTY with the rule", () => {
    const W = code(readFileSync(resolve(root, "src/services/line-webhook.service.ts"), "utf8"));
    expect(W).not.toContain("229");
    expect(W).not.toMatch(new RegExp(`${ENV}\\s*\\?\\?`));
    const branch = W.slice(W.indexOf('if (role === "admin") {'), W.indexOf('if (role === "teacher") {'));
    expect(branch.length).toBeGreaterThan(200);
    expect(branch).not.toContain("process.env");
    const EX = readFileSync(resolve(root, ".env.example"), "utf8");
    expect(EX).toMatch(new RegExp(`^${ENV}=$`, "m"));
    expect(EX).toContain("NO DEFAULT — min 8 chars, never 229");
  });
  test("🔑 the BOOT is untouched: importing the app with the shared value unset throws nothing (refusing the act, not the product)", async () => {
    delete process.env[ENV];
    const app = (await import("../index")).default as { fetch: unknown };
    expect(typeof app.fetch).toBe("function");
  });
});

describe("3️⃣ 🚫 every refusal is the SAME reply — the chat learns nothing about the code, its age, its owner, or which check failed", () => {
  const refusal = async (setup: (typedFor: { userId: string }) => string) => {
    USERS = [];
    const w = world();
    const typed = setup({ userId: w.userId });
    const before = w.snapshot();
    await w.say(typed);
    return { reply: w.replies.join("\n"), unchanged: w.snapshot() === before, settled: w.settled, step: w.s.step, strikes: w.s.unexpectedCount };
  };
  test("wrong · shaped like nothing · expired · already used · the user is disabled · a coach account · this LINE is another user's · over the miss limit (even with the RIGHT code) ⇒ ONE identical reply, nothing written, strike 1", async () => {
    const out = [
      await refusal(() => { userWithCode(); return generateLinkCode(); }), // a well-shaped code nobody holds
      await refusal(() => { userWithCode(); return "wrong-guess-1"; }),
      await refusal(() => userWithCode({}, -1_000).plain), // expired a second ago
      await refusal(() => { const { plain } = userWithCode(); USERS[0]!.lineUserId = null; USERS[0]!.lineLinkCodeHash = null; USERS[0]!.lineLinkCodeExpiresAt = null; return plain; }), // burned
      await refusal(() => userWithCode({ disabledAt: new Date() }).plain),
      await refusal(() => userWithCode({ teacherId: "11111111-1111-4111-8111-111111111111" }).plain),
      await refusal(({ userId }) => { const { plain } = userWithCode(); userWithCode({ lineUserId: userId }); return plain; }), // this chat's LINE is already ANOTHER user's
      await refusal(({ userId }) => { const { plain } = userWithCode(); for (let i = 0; i < ADMIN_CODE_MISS_LIMIT; i++) recordAdminLinkAttempt(userId, { miss: true, reason: "test" }); return plain; }),
    ];
    const first = out[0]!;
    expect(first.reply).toContain(t("verify_admin_bad", "TH"));
    for (const o of out) expect(o).toEqual({ reply: first.reply, unchanged: true, settled: [], step: "AWAIT_CODE", strikes: 1 });
    for (const o of out) expect(o.reply).not.toMatch(/expire|used|disabled|limit|another|coach|หมดอายุ|ใช้แล้ว|ถูกระงับ|เกิน/i);
  });
  test("✅ a live code ⇒ THAT user is linked (their `line_user_id`), the code is burned, the admin menu is settled, and the success reply is unchanged", async () => {
    USERS = [];
    const { u, plain } = userWithCode();
    const other = userWithCode().u; // another user's code is not touched
    const w = world();
    await w.say(plain);
    expect(w.replies.join("\n")).toContain(t("verify_admin_ok", "TH"));
    expect(u).toMatchObject({ lineUserId: w.userId, lineLinkCodeHash: null, lineLinkCodeExpiresAt: null });
    expect(other.lineUserId).toBeNull();
    expect(other.lineLinkCodeHash).not.toBeNull();
    expect(w.settled).toEqual([w.userId]);
    expect(w.settingsWrites).toEqual([]); // 🔴 the legacy list is never written
  });
  test("typing is forgiving, the code is not: lower case, spaces and a hyphen link; ONE wrong character does not", async () => {
    USERS = [];
    const { u, plain } = userWithCode();
    const bad = world();
    await bad.say(plain.slice(0, 7) + (plain[7] === "2" ? "3" : "2"));
    expect(u.lineUserId).toBeNull();
    const ok = world();
    await ok.say(` ${plain.slice(0, 4).toLowerCase()}-${plain.slice(4).toLowerCase()} `);
    expect(u.lineUserId).toBe(ok.userId);
  });
  test("🔴 SINGLE USE: the second chat that types the same code is refused, and the first user's link is untouched", async () => {
    USERS = [];
    const { u, plain } = userWithCode();
    const first = world();
    await first.say(plain);
    expect(u.lineUserId).toBe(first.userId);
    const second = world();
    await second.say(plain);
    expect(second.replies.join("\n")).toContain(t("verify_admin_bad", "TH"));
    expect(u.lineUserId).toBe(first.userId);
  });
  test("🔴 the LOG says why, loudly — and never the typed text, the code, or its hash", async () => {
    USERS = [];
    const { plain } = userWithCode({}, -1_000); // an EXPIRED code, typed
    await world().say(plain);
    await world().say("near-miss-0000");
    const all = logs.join("\n");
    expect(all).toContain("[SEC-1] admin link code: a miss from …");
    expect(all).toContain("(expired)");
    expect(all).not.toContain(plain);
    expect(all).not.toContain(hashLinkCode(plain));
    expect(all).not.toContain("near-miss-0000");
  });
  test("by source: no console call in the gate passes the typed text, the code or a hash", () => {
    const G = code(readFileSync(resolve(root, "src/lib/line-admin-code.ts"), "utf8"));
    const calls = [...G.matchAll(/console\.(log|info|warn|error|debug)\(([\s\S]*?)\);/g)].map((m) => m[2]!);
    expect(calls.length).toBe(2);
    for (const a of calls) expect({ a: a.slice(0, 60), leaks: /typed|normalized|hash|digest/.test(a) }).toEqual({ a: a.slice(0, 60), leaks: false });
  });
});

describe("4️⃣ the per-user miss limit — the shop-front's limiter, reused; and the un-mute cannot reset it", () => {
  test("the shop-front limiter's own limits are UNCHANGED (its defaults are the old constants)", () => {
    expect([SHOPFRONT_WINDOW_MS, SHOPFRONT_MISS_LIMIT, SHOPFRONT_TOTAL_LIMIT]).toEqual([600_000, 5, 60]);
    const l = new ShopfrontRateLimit();
    for (let i = 0; i < 5; i++) l.record("ip", 1_000, true);
    expect([l.blocked("ip", 1_000), l.blocked("ip", 1_000 + 600_001)]).toEqual([true, false]);
    expect(shopfrontRateLimit).toBeInstanceOf(ShopfrontRateLimit);
  });
  test(`${ADMIN_CODE_MISS_LIMIT} misses per LINE user per ${ADMIN_CODE_WINDOW_MS / 60_000} min; then refused WITHOUT looking up; per user; the window lets them back`, () => {
    const l = new ShopfrontRateLimit({ windowMs: ADMIN_CODE_WINDOW_MS, missLimit: ADMIN_CODE_MISS_LIMIT, totalLimit: Number.POSITIVE_INFINITY });
    for (let i = 0; i < ADMIN_CODE_MISS_LIMIT - 1; i++) recordAdminLinkAttempt("Ua", { miss: true, reason: "t" }, 0, l);
    expect(adminLinkBlocked("Ua", 1, l)).toBe(false); // one short of the limit
    recordAdminLinkAttempt("Ua", { miss: true, reason: "t" }, 0, l);
    expect(adminLinkBlocked("Ua", 1, l)).toBe(true);
    expect(adminLinkBlocked("Ub", 1, l)).toBe(false); // another user is not affected
    expect(adminLinkBlocked("Ua", ADMIN_CODE_WINDOW_MS + 1, l)).toBe(false); // the window passed
  });
  test("🔑 the loop the two-strikes mute allowed — miss, miss, un-mute (`เปิดเมนู`), retry — no longer walks the code, even with a LIVE code in the table", async () => {
    USERS = [];
    const { u, plain } = userWithCode();
    const w = world();
    for (let i = 0; i < ADMIN_CODE_MISS_LIMIT; i++) {
      Object.assign(w.s, { step: "AWAIT_CODE", pendingRole: "admin", unexpectedCount: 0, mutedUntil: null }); // as if un-muted and restarted
      await w.say(`guess-${i}`);
    }
    Object.assign(w.s, { step: "AWAIT_CODE", pendingRole: "admin", unexpectedCount: 0, mutedUntil: null });
    await w.say(plain); // the RIGHT code, from an account over the limit
    expect(u.lineUserId).toBeNull(); // the session was reset every time; the limit was not
  });
});

describe("📌 the structure, and what did NOT move", () => {
  test("the link is ONE call in the admin branch, in front of the menu — and a refusal returns the same `verify_admin_bad` before anything else", () => {
    const W = code(readFileSync(resolve(root, "src/services/line-webhook.service.ts"), "utf8"));
    const branch = W.slice(W.indexOf('if (role === "admin") {'), W.indexOf('if (role === "teacher") {'));
    const link = branch.indexOf("linkLineByCode(");
    expect(link).toBeGreaterThan(0);
    expect((branch.match(/linkLineByCode\(/g) ?? []).length).toBe(1);
    expect(branch.indexOf('t("verify_admin_bad", l)')).toBeGreaterThan(link);
    expect(branch.indexOf("settleAdminLink")).toBeGreaterThan(link);
    expect(branch).not.toMatch(/addAdminLineUserId|checkAdminCode/);
  });
  test("teacher and parent linking untouched — the admin branch returns before either; strikes and the hand-off rule unchanged", () => {
    const W = code(readFileSync(resolve(root, "src/services/line-webhook.service.ts"), "utf8"));
    expect(W).toContain("if (!res.ok) return strikeOrPrompt(lineUserId, session, replyToken, both(res.message), lang);");
    expect(W).toContain('if (role !== "admin") await settleLinkedRole(lineUserId, role);');
    expect(W).toContain('if (action === "admin") return doCallAdmin(lineUserId, replyToken, lang);'); // TASK-524's
  });
});
