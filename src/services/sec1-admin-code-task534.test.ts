// 🔴🔴 TASK-534 (SEC-1) — the bot printed the admin code as an EXAMPLE (`(เช่น 229)`) and the check defaulted to that value, so any
// follower could link as an admin and receive every family's leave notices. Pinned here: no example in any secret prompt (a RULE
// over all strings) · no default, a minimum strength, retired values refused — the LINKING refused, never the boot · every refusal
// the SAME reply, nothing about the code in the chat or the log · a per-user miss limit that the un-mute cannot reset.
// Through the REAL dispatcher, over an in-memory `line_link_sessions` row (the TASK-520 harness shape).
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import { handleLineWebhookEvents } from "./line-webhook.service";
import * as registerSvc from "./line-register.service";
import * as lineAdmin from "../lib/line-admin";
import * as lineClient from "../lib/line-client";
import { allChatStrings, t } from "../lib/line-i18n";
import { ADMIN_CODE_MIN_LENGTH, ADMIN_CODE_MISS_LIMIT, ADMIN_CODE_WINDOW_MS, adminCodeConfig, adminCodeMatches, checkAdminCode } from "../lib/line-admin-code";
import { SHOPFRONT_MISS_LIMIT, SHOPFRONT_TOTAL_LIMIT, SHOPFRONT_WINDOW_MS, ShopfrontRateLimit, shopfrontRateLimit } from "../lib/shopfront-rate-limit";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const dialect = new PgDialect();
const spies: Array<{ mockRestore: () => void }> = [];
const ENV = "LINE_ADMIN_VERIFY_CODE";
const saved = process.env[ENV];
// Built at runtime, never a literal credential in the repo (the workspace rule).
const STRONG = ["k7", "Qm", "2x", "9p"].join("");
const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  for (const m of ["error", "warn", "info", "log"] as const) spies.push(spyOn(console, m).mockImplementation(((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }) as any));
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
});

type Row = { lineUserId: string; step: string; pendingRole: string | null; draft: unknown; unexpectedCount: number; mutedUntil: Date | null; updatedAt: Date };
let seq = 0;
/** A fresh chat at the admin code step (a fresh LINE user each time, so the module's miss limit is per-test). */
function world(userId = `Uadm${++seq}sec1`) {
  const s: Row = { lineUserId: userId, step: "AWAIT_CODE", pendingRole: "admin", draft: null, unexpectedCount: 0, mutedUntil: null, updatedAt: new Date() };
  const replies: string[] = [];
  const linked: string[] = [];
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => ({ ...s })) as any));
  spies.push(spyOn(db, "update").mockImplementation(((table: any) => ({ set: (set: any) => ({ where: async (cond: any) => {
    if (getTableName(table) !== "line_link_sessions") return;
    const { sql, params } = dialect.sqlToQuery(cond);
    if (sql.includes(`"line_link_sessions"."line_user_id" = $1`) && params[0] === s.lineUserId) Object.assign(s, set);
  } }) })) as any));
  spies.push(spyOn(db, "insert").mockImplementation((() => ({ values: () => ({ onConflictDoUpdate: async () => {}, onConflictDoNothing: async () => {} }) })) as any));
  spies.push(spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })) as any));
  spies.push(spyOn(db, "delete").mockImplementation((() => ({ where: async () => { s.step = "CLEARED"; } })) as any)); // `clearSession` after a link
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(lineAdmin, "addAdminLineUserId").mockImplementation((async (id: string) => { linked.push(id); }) as any));
  spies.push(spyOn(registerSvc, "settleAdminLink").mockImplementation((async () => {}) as any));
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { for (const x of m) replies.push(x.text); }) as any));
  const say = (text: string) => handleLineWebhookEvents([{ type: "message", replyToken: "rt", source: { userId }, message: { type: "text", text } } as any]);
  return { s, replies, linked, say, userId };
}

describe("1️⃣ the prompt — no example, and it is a RULE over every chat string (TASK-479's shape)", () => {
  test("`code_admin` now asks, and shows nothing", () => {
    expect([t("code_admin", "TH"), t("code_admin", "EN")]).toEqual(["กรุณาพิมพ์รหัสแอดมิน", "Please type the admin code"]);
  });
  test("🔑 no chat string that asks for a secret (code · password · PIN · OTP) carries an example (เช่น · e.g. · ตัวอย่าง · example)", () => {
    const secret = /รหัส|\bcode\b|password|\bPIN\b|\bOTP\b/i, example = /เช่น|e\.g\.|ตัวอย่าง|\bexample\b/i;
    const all = allChatStrings();
    expect(all.length).toBeGreaterThan(200); // the whole table (232 on 2026-09-28), not a sample
    expect(all.some(([k]) => k === "code_admin")).toBe(true);
    const hits = all.flatMap(([k, th, en]) => [th, en].filter((x) => secret.test(x) && example.test(x)).map(() => k));
    expect(hits).toEqual([]);
  });
  test("…and the retired code appears in NO chat string, anywhere", () => {
    expect(allChatStrings().filter(([, th, en]) => /(^|\D)229(\D|$)/.test(th + " " + en)).map(([k]) => k)).toEqual([]);
  });
});

describe("2️⃣ no default · 3️⃣ a minimum strength — the config, and the LINKING (not the boot) refused", () => {
  test("unset · blank · the retired value · shorter than the minimum ⇒ refused, each with its reason (for the LOG)", () => {
    expect(ADMIN_CODE_MIN_LENGTH).toBe(8);
    expect([undefined, "", "   ", "229", " 229 ", "Ab3$efg"].map((v) => adminCodeConfig(v))).toEqual([
      { ok: false, problem: "unset" }, { ok: false, problem: "unset" }, { ok: false, problem: "unset" },
      { ok: false, problem: "retired" }, { ok: false, problem: "retired" }, { ok: false, problem: "short" },
    ]);
    expect(adminCodeConfig(` ${STRONG} `)).toEqual({ ok: true, code: STRONG });
  });
  test("the comparison: exact after trimming what was typed; a different length is simply false", () => {
    expect(adminCodeMatches(STRONG, ` ${STRONG}\n`)).toBe(true);
    expect(adminCodeMatches(STRONG, STRONG.slice(0, 7) + "x")).toBe(false);
    expect(adminCodeMatches(STRONG, STRONG + "x")).toBe(false);
  });
  test("🔴 no default anywhere: the check reads the env through the gate only, `229` is gone from the service, and `.env.example` is EMPTY with the rule", () => {
    const W = code(readFileSync(resolve(root, "src/services/line-webhook.service.ts"), "utf8"));
    expect(W).not.toContain("229");
    expect(W).not.toMatch(/LINE_ADMIN_VERIFY_CODE\s*\?\?/);
    expect(W).toContain('if (!checkAdminCode(lineUserId, code, process.env[ADMIN_CODE_ENV])) return { ok: false, message: (l) => t("verify_admin_bad", l) };');
    const EX = readFileSync(resolve(root, ".env.example"), "utf8");
    expect(EX).toMatch(/^LINE_ADMIN_VERIFY_CODE=$/m);
    expect(EX).toContain("NO DEFAULT — min 8 chars, never 229");
  });
  test("🔑 the BOOT is untouched: importing the app with the code unset throws nothing (refusing the act, not the product)", async () => {
    delete process.env[ENV];
    const app = (await import("../index")).default as { fetch: unknown };
    expect(typeof app.fetch).toBe("function");
  });
});

describe("🚫 every refusal is the SAME reply — the chat learns nothing about the code, its length, or which check failed", () => {
  const refusal = async (env: string | undefined, typed: string, pre?: (userId: string) => void) => {
    if (env === undefined) delete process.env[ENV]; else process.env[ENV] = env;
    const w = world();
    pre?.(w.userId);
    await w.say(typed);
    return { reply: w.replies.join("\n"), linked: w.linked, step: w.s.step, strikes: w.s.unexpectedCount };
  };
  test("wrong code · unset · short · retired · over the miss limit (even with the RIGHT code) ⇒ one identical reply, nobody linked, strike 1", async () => {
    const out = [
      await refusal(STRONG, "wrong-guess-1"),
      await refusal(undefined, "anything"),
      await refusal("short", "short"), // typing the configured (too-short) value itself still does not link
      await refusal("229", "229"), // the retired value, even when it is what is set and what is typed
      await refusal(STRONG, STRONG, (u) => { for (let i = 0; i < ADMIN_CODE_MISS_LIMIT; i++) checkAdminCode(u, "nope", STRONG); }),
    ];
    const first = out[0]!;
    expect(first.reply).toContain(t("verify_admin_bad", "TH"));
    for (const o of out) expect(o).toEqual({ reply: first.reply, linked: [], step: "AWAIT_CODE", strikes: 1 });
    for (const o of out) expect(o.reply).not.toMatch(/229|short|unset|retired|limit|8|characters|ตัวอักษร/i);
  });
  test("✅ the right code, configured properly ⇒ linked, and the success reply — unchanged", async () => {
    process.env[ENV] = STRONG;
    const w = world();
    await w.say(STRONG);
    expect(w.linked).toEqual([w.userId]);
    expect(w.replies.join("\n")).toContain(t("verify_admin_ok", "TH"));
  });
  test("🔴 the LOG says why, loudly — and never the typed text, the configured value, or its length", async () => {
    process.env[ENV] = "1234567"; // 7 — one short
    await world().say("1234567");
    process.env[ENV] = STRONG;
    await world().say("near-" + STRONG.slice(0, 6));
    const all = logs.join("\n");
    expect(all).toContain("🔴🔴 [SEC-1] admin linking REFUSED — LINE_ADMIN_VERIFY_CODE is short.");
    expect(all).toContain("[SEC-1] admin code: a wrong code from …");
    expect(all).not.toContain("1234567");
    expect(all).not.toContain(STRONG.slice(0, 6));
    expect(all).not.toMatch(/length|\b7\b/);
  });
  test("by source: no console call in the gate passes the typed text or the configured code", () => {
    const G = code(readFileSync(resolve(root, "src/lib/line-admin-code.ts"), "utf8"));
    const calls = [...G.matchAll(/console\.(log|info|warn|error|debug)\(([\s\S]*?)\);/g)].map((m) => m[2]!);
    expect(calls.length).toBe(3);
    for (const a of calls) expect({ a: a.slice(0, 60), leaks: /typed|cfg\.code|\benv\b/.test(a) }).toEqual({ a: a.slice(0, 60), leaks: false });
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
  test(`${ADMIN_CODE_MISS_LIMIT} misses per LINE user per ${ADMIN_CODE_WINDOW_MS / 60_000} min; then refused WITHOUT comparing; per user; the window lets them back`, () => {
    const l = new ShopfrontRateLimit({ windowMs: ADMIN_CODE_WINDOW_MS, missLimit: ADMIN_CODE_MISS_LIMIT, totalLimit: Number.POSITIVE_INFINITY });
    for (let i = 0; i < ADMIN_CODE_MISS_LIMIT; i++) expect(checkAdminCode("Ua", "nope", STRONG, 0, l)).toBe(false);
    expect(checkAdminCode("Ua", STRONG, STRONG, 1, l)).toBe(false); // the right code, refused: over the limit
    expect(checkAdminCode("Ub", STRONG, STRONG, 1, l)).toBe(true); // another user is not affected
    expect(checkAdminCode("Ua", STRONG, STRONG, ADMIN_CODE_WINDOW_MS + 1, l)).toBe(true); // the window passed
  });
  test("🔑 the loop the two-strikes mute allowed — miss, miss, un-mute (`เปิดเมนู`), retry — no longer walks the code", async () => {
    process.env[ENV] = STRONG;
    const w = world();
    for (let i = 0; i < ADMIN_CODE_MISS_LIMIT; i++) {
      Object.assign(w.s, { step: "AWAIT_CODE", pendingRole: "admin", unexpectedCount: 0, mutedUntil: null }); // as if un-muted and restarted
      await w.say(`guess-${i}`);
    }
    Object.assign(w.s, { step: "AWAIT_CODE", pendingRole: "admin", unexpectedCount: 0, mutedUntil: null });
    await w.say(STRONG);
    expect(w.linked).toEqual([]); // the session was reset every time; the limit was not
  });
});

describe("📌 approval-readiness, and what did NOT move", () => {
  test("the gate is ONE call in front of the success half — approval would replace what follows it, not the gate", () => {
    const W = code(readFileSync(resolve(root, "src/services/line-webhook.service.ts"), "utf8"));
    const branch = W.slice(W.indexOf('if (role === "admin") {'), W.indexOf('if (role === "teacher") {'));
    const gate = branch.indexOf("checkAdminCode(");
    expect(gate).toBeGreaterThan(0);
    expect(branch.indexOf("await addAdminLineUserId(lineUserId);")).toBeGreaterThan(gate);
    expect((branch.match(/checkAdminCode\(/g) ?? []).length).toBe(1);
  });
  test("teacher and parent linking untouched — the admin branch returns before either; strikes and the hand-off rule unchanged", () => {
    const W = code(readFileSync(resolve(root, "src/services/line-webhook.service.ts"), "utf8"));
    expect(W).toContain("if (!res.ok) return strikeOrPrompt(lineUserId, session, replyToken, both(res.message), lang);");
    expect(W).toContain('if (role !== "admin") await settleLinkedRole(lineUserId, role);');
    expect(W).toContain('if (action === "admin") return doCallAdmin(lineUserId, replyToken, lang);'); // TASK-524's
  });
});
