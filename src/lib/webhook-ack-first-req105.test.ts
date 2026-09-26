// TASK-460 (REQ-105 §7, DEF-1) — LINE times out on our webhook: **14 × `request_timeout` on 2026-09-24, on the
// REAL customer OA**, at exactly the times we were chasing as "the message never arrived". It had arrived; we were
// still working. The fix is when we say 200 — not what we do afterwards.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSrc } from "./read-src";
import { formatBadSignature, formatEventFinish, formatInboundEvent } from "./line-log";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { createHmac } from "node:crypto";
import { fakeDispatchBoundary } from "../test-support/line-dispatch-fakes"; // TASK-507

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
process.env.LINE_CHANNEL_SECRET ??= "test-line-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const svc = await import("../services/line-webhook.service");
const lineClient = await import("./line-client");
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
// 🔴 TASK-507 — a postback first resolves its reply language (`resolveBotLang`: the sender's teacher / parent link), then un-mutes
// the chat, reads the family link and the OA admin list. The by-value tests below declared none of it, so it went to the REAL database (unreachable,
// the first read errored inside the handler — logged, and tolerated, since only ORDER / FINISH lines are asserted — and hid the
// rest). Declared: U1 is nobody — no teacher, no parent, no session, no family (the shared dispatcher fakes), and there are no OA
// admins (only the `line_admin_user_ids` setting is answered); anything else throws.
const teacherAsked: unknown[] = [];
const declareStranger = async () => {
  const { db } = await import("../db");
  teacherAsked.length = 0;
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async (q: any) => { teacherAsked.push(q.where({ lineUserId: "lineUserId" }, { eq: (_c: unknown, v: unknown) => v })); return undefined; }) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async (q: any) => {
    const key = q.where({ key: "key" }, { eq: (_c: unknown, v: unknown) => v });
    if (key !== "line_admin_user_ids") throw new Error(`unexpected app_settings read: ${key}`);
    return undefined;
  }) as any));
  return fakeDispatchBoundary(spies);
};

const SECRET = process.env.LINE_CHANNEL_SECRET!;
const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("base64");
const post = (body: string, headers: Record<string, string> = {}) =>
  rootApp.fetch(new Request("http://localhost/api/webhooks/line", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));
const bodyOf = (events: any[]) => JSON.stringify({ destination: "U0", events });
const U1 = "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";

// ═══════════════════ §1 the 200 comes FIRST ═══════════════════

describe("🔴 §1 ACK first, process after — by value, through the real route", () => {
  test("🔑 a handler that takes a second cannot delay the 200 (the whole defect, in one assertion)", async () => {
    let released!: () => void;
    const gate = new Promise<void>((r) => { released = r; });
    let finished = false;
    spies.push(spyOn(svc, "handleLineWebhookEvents").mockImplementation((async () => { await gate; finished = true; }) as any));

    const body = bodyOf([{ type: "message", webhookEventId: "e-1", replyToken: "r1", source: { userId: U1 }, message: { type: "text", id: "m1", text: "hi" } }]);
    const res = await post(body, { "x-line-signature": sign(body) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // 🔴 The handler has NOT finished — before this task, the response waited for exactly this.
    expect(finished).toBe(false);
    released();
    await gate;
  });

  test("🚫 a handler that THROWS still answers 200, and the rejection is logged — never lost silently", async () => {
    const errors: string[] = [];
    spies.push(spyOn(console, "error").mockImplementation(((...a: any[]) => { errors.push(a.map(String).join(" ")); }) as any));
    spies.push(spyOn(svc, "handleLineWebhookEvents").mockImplementation((async () => { throw new Error("boom"); }) as any));
    const body = bodyOf([{ type: "message", webhookEventId: "e-2", replyToken: "r2", source: { userId: U1 }, message: { type: "text", id: "m2", text: "hi" } }]);
    const res = await post(body, { "x-line-signature": sign(body) });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5)); // the detached tail
    expect(errors.some((e) => e.includes("[line-webhook] detached handler rejected:"))).toBe(true);
  });

  test("📌 by source: the `await` is gone from the route, and the detached promise has a catch", () => {
    const W = code(src("src/routes/webhooks.ts"));
    expect(W).not.toContain("await handleLineWebhookEvents(");
    expect(W).toContain("void handleLineWebhookEvents(parsed.events ?? []).catch((e) => {");
    // the ACK is the LAST thing, after the signature check — order, by source
    expect(W.indexOf("verifyLineSignature(")).toBeLessThan(W.indexOf("void handleLineWebhookEvents("));
  });

  test("🚫 the signature check is untouched: a bad signature is still 401 and never reaches the handler", async () => {
    let called = 0;
    spies.push(spyOn(svc, "handleLineWebhookEvents").mockImplementation((async () => { called++; }) as any));
    spies.push(spyOn(console, "warn").mockImplementation(((..._a: any[]) => {}) as any));
    const body = bodyOf([{ type: "message", webhookEventId: "e-3" }]);
    const res = await post(body, { "x-line-signature": "not-a-signature" });
    expect(res.status).toBe(401);
    expect(called).toBe(0);
  });
});

// ═══════════════════ §2 the 401 finally says something ═══════════════════

describe("🔴 §2 the rejected signature is logged — and never the body", () => {
  test("by value: the header's presence, the body LENGTH and the remote hint; 🚫 no body, no signature", async () => {
    const warns: string[] = [];
    spies.push(spyOn(console, "warn").mockImplementation(((...a: any[]) => { warns.push(a.map(String).join(" ")); }) as any));
    const body = bodyOf([{ type: "message", webhookEventId: "e-4", message: { type: "text", id: "m", text: "SECRET-TEXT" } }]);
    await post(body, { "x-line-signature": "wrong", "x-forwarded-for": "203.0.113.9" });
    const line = warns.find((w) => w.includes("401 invalid signature"))!;
    expect(line).toContain("sig=present");
    expect(line).toContain(`bodyLen=${body.length}`);
    expect(line).toContain("from=203.0.113.9");
    expect(line).not.toContain("SECRET-TEXT"); // 🚫 the body is signed third-party content
    expect(line).not.toContain("wrong"); // 🚫 and never the signature itself
  });

  test("a MISSING header reads differently from a wrong one — that is the question the line exists to answer", () => {
    expect(formatBadSignature({ hasSignature: false, bodyLength: 12, remote: null })).toBe("[line-in] 401 invalid signature — sig=MISSING bodyLen=12 from=(unknown)");
    expect(formatBadSignature({ hasSignature: true, bodyLength: 12, remote: "1.2.3.4" })).toBe("[line-in] 401 invalid signature — sig=present bodyLen=12 from=1.2.3.4");
  });
});

// ═══════════════════ §3 idempotency — the INSERT is the dedupe ═══════════════════

describe("🔴 §3 a duplicate event has NO side effect", () => {
  test("by source: the insert is `onConflictDoNothing().returning()`, and it runs BEFORE the dispatch", () => {
    const S = code(src("src/services/line-webhook.service.ts"));
    const F = region(S, "async function firstDelivery(", "\n}\n");
    expect(F).toContain(".onConflictDoNothing().returning(");
    expect(F).toContain("if (!id) return true;"); // an event with no id is processed, never dropped
    const H = region(S, "async function handleOneEvent(", "\n}\n");
    expect(H.indexOf("if (!(await firstDelivery(ev)))")).toBeLessThan(H.indexOf('if (ev.type === "message")'));
    // 🚫 not a read-then-check: two concurrent deliveries of one id could both pass that
    expect(F).not.toContain("findFirst");
  });

  test("by value: the second delivery of one id dispatches NOTHING and says `duplicate`", async () => {
    const seen = new Set<string>();
    const db = (await import("../db")).db;
    spies.push(spyOn(db, "insert").mockImplementation(((_t: any) => ({
      values: (v: any) => ({ onConflictDoNothing: () => ({ returning: async () => (seen.has(v.webhookEventId) ? [] : (seen.add(v.webhookEventId), [{ id: v.webhookEventId }])) }) }),
    })) as any));
    const infos: string[] = [];
    spies.push(spyOn(console, "info").mockImplementation(((...a: any[]) => { infos.push(a.map(String).join(" ")); }) as any));
    // 🚫 no test may touch api.line.me — the apology path replies on an unknown action.
    spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async () => {}) as any));
    const ev = { type: "postback", webhookEventId: "dup-1", replyToken: "r", source: { userId: U1 }, postback: { data: "action=nothing" } } as any;
    await declareStranger(); // TASK-507

    await svc.handleLineWebhookEvents([ev]);
    await svc.handleLineWebhookEvents([ev]); // LINE re-delivers the SAME event
    const finishes = infos.filter((i) => i.includes("FINISH id=dup-1"));
    expect(finishes).toHaveLength(2);
    expect(finishes[1]).toContain("outcome=duplicate");
    expect(finishes[0]).not.toContain("outcome=duplicate");
  });

  test("the store: `0055`, 56 = 56, and the table is its own witness", () => {
    const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
    expect(journal.entries.length).toBe(60); // TASK-497: +0059
    expect(journal.entries[55]).toMatchObject({ idx: 55, tag: "0055_line_webhook_events" });
    const sql = readFileSync(resolve(root, "drizzle/0055_line_webhook_events.sql"), "utf8");
    expect(sql).toContain(`"webhook_event_id" text PRIMARY KEY`);
    expect(sql).toContain("db:verify` expects 56");
    expect(SCHEDULING_WITNESSES.find((w) => w.tag === "0055_line_webhook_events")).toMatchObject({ probe: { kind: "table", table: "line_webhook_events" }, rerunnable: true });
    // 🚫 no column on `line_link_sessions` — a key that vanishes when the flow ends is not a key
    expect(code(src("src/db/schema.ts"))).not.toMatch(/lineLinkSessions[\s\S]{0,800}webhookEventId/);
  });

  test("the sweep rides the EXISTING day-end job — 🚫 no new job, no new registration", () => {
    const J = code(src("src/services/jobs.service.ts"));
    const F = region(J, "export async function runEndOfDayJob(", "\n}\n");
    // the DELETE must be awaited and its result counted — a `void db.delete(...)` that nobody waits for is a
    // sweep that silently does nothing on a slow night, and reads identically in a grep.
    expect(F).toContain("const swept = await db");
    expect(F).toContain(".delete(lineWebhookEvents)");
    expect(F).toContain("webhookEventsSwept: swept.length");
    expect(J).toContain("export const WEBHOOK_EVENT_TTL_DAYS = 7;");
    expect(code(src("src/routes/internal.ts"))).not.toContain("webhook-events-sweep");
  });
});

// ═══════════════════ §4 one chat at a time ═══════════════════

describe("🔴 §4 the per-chat queue — and what it is not", () => {
  test("by value: two events from ONE chat are strictly sequential, even when the first is slow", async () => {
    const order: string[] = [];
    const db = (await import("../db")).db;
    spies.push(spyOn(db, "insert").mockImplementation(((_t: any) => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: "x" }] }) }) })) as any));
    spies.push(spyOn(console, "info").mockImplementation(((..._a: any[]) => {}) as any));
    const errors: string[] = []; // TASK-507 — was silenced outright: an undeclared read failing inside the handler vanished here
    spies.push(spyOn(console, "error").mockImplementation(((...a: any[]) => { errors.push(a.map(String).join(" ")); }) as any));
    // the dispatch itself is what we time: a postback with an unknown action does no I/O beyond the language read (declared — TASK-507)
    const { unmutes } = await declareStranger();
    spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async () => {}) as any));
    const mk = (id: string) => ({ type: "postback", webhookEventId: id, replyToken: "r", source: { userId: U1 }, postback: { data: `action=slow-${id}` } }) as any;
    const slow = svc.handleLineWebhookEvents([mk("a")]).then(() => order.push("a"));
    const fast = svc.handleLineWebhookEvents([mk("b")]).then(() => order.push("b"));
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a", "b"]); // b waited for a's tail
    // TASK-507 — every teacher lookup was by the sender, and each event un-muted that one chat
    expect(teacherAsked.length).toBeGreaterThan(0);
    expect(teacherAsked.every((v) => v === U1)).toBe(true);
    expect(unmutes.map((q) => q.params[0])).toEqual([U1, U1]);
    expect(errors).toEqual([]); // both events handled cleanly — nothing failed behind the timing
  });

  test("📌 two DIFFERENT chats are NOT serialised — the lock is per chat, not a global queue", () => {
    const S = code(src("src/services/line-webhook.service.ts"));
    const Q = region(S, "function onChatQueue(", "\n}\n");
    expect(Q).toContain("chatQueues.get(key)");
    expect(Q).toContain("prev.then(work, work)"); // a failed event cannot poison the chain
    expect(Q).toContain("if (chatQueues.get(key) === next) chatQueues.delete(key);"); // only the tail clears
    expect(S).toContain(`await onChatQueue(eventUserId(ev) ?? "anon", () => handleOneEvent(ev));`);
  });

  test("⚠️ the single-process limit is STATED in the file, not implied", () => {
    const S = src("src/services/line-webhook.service.ts");
    expect(S).toContain("serialises within ONE process");
    expect(S).toContain("not a distributed lock");
    expect(S).toContain("pg_advisory_xact_lock"); // …and why it was refused
  });
});

// ═══════════════════ §5 the evidence we now have to supply ourselves ═══════════════════

describe("🔴 §5 `[line-in]` carries the id, and there is a FINISH line for every event", () => {
  const ev = { type: "message", webhookEventId: "e-9", source: { userId: U1 }, message: { type: "text", id: "m", text: "hi" } } as any;

  test("by value: the id on the way in, the redelivery flag when LINE says so, the id + outcome + ms on the way out", () => {
    expect(formatInboundEvent(ev)).toContain("id=e-9");
    expect(formatInboundEvent(ev)).not.toContain("REDELIVERY");
    expect(formatInboundEvent({ ...ev, deliveryContext: { isRedelivery: true } })).toContain("REDELIVERY");
    expect(formatEventFinish(ev, "ok", 1234.6)).toBe(`[line-in] FINISH id=e-9 ${formatInboundEvent(ev).match(/u:[0-9a-f]{8}/)![0]} outcome=ok ms=1235`);
    // 🚫 the privacy rule is unchanged: the marker, never the userId
    expect(formatEventFinish(ev, "ok", 1)).not.toContain(U1);
    expect(formatInboundEvent(ev)).not.toContain(U1);
  });

  test("🔑 a throwing event STILL finishes (the `finally`) — a lost step must be a line with no FINISH, not nothing", () => {
    const S = code(src("src/services/line-webhook.service.ts"));
    const H = region(S, "async function handleOneEvent(", "\n}\n");
    expect(H).toContain("} finally {");
    expect(H.indexOf("} finally {")).toBeLessThan(H.indexOf("formatEventFinish(ev, outcome"));
    expect(H).toContain(`outcome = "error";`);
    expect(H).toContain(`outcome = "error+apology-failed";`); // an expired reply token reads as itself
  });

  test("📌 the event type carries what LINE always sent and we always threw away", () => {
    const L = code(src("src/lib/line-webhook.ts"));
    expect(L).toContain("webhookEventId?: string;");
    expect(L).toContain("deliveryContext?: { isRedelivery?: boolean };");
  });
});
