// TASK-520 — a newly linked coach's FIRST message is answered, not swallowed into a hand-off — because the linking conversation
// ENDS when the link is settled (a queued claim; a staff approval), and ending it can never end a mute.
// Through the REAL dispatcher, over an in-memory `line_link_sessions` row whose UPDATEs are judged by their rendered SQL.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import { handleLineWebhookEvents } from "./line-webhook.service";
import * as teacherLink from "./teacher-link.service";
import * as checkinSvc from "./checkin.service";
import * as lineClient from "../lib/line-client";
import { endLinkingConversation } from "./line-register.service";
import { t } from "../lib/line-i18n";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const dialect = new PgDialect();
const U = "Ucoach0520";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

type Row = { lineUserId: string; step: string; pendingRole: string | null; draft: unknown; unexpectedCount: number; mutedUntil: Date | null; updatedAt: Date };
/** One chat's session row, the teacher's link state, and everything the bot said. */
function world(row: Partial<Row>, opts: { linked: () => boolean; claim?: string } ) {
  const s: Row = { lineUserId: U, step: "AWAIT_CODE", pendingRole: "teacher", draft: null, unexpectedCount: 0, mutedUntil: null, updatedAt: new Date(), ...row };
  const replies: string[] = [];
  const calls: string[] = [];
  const applySessionUpdate = (set: Record<string, unknown>, cond: any) => {
    const { sql, params } = dialect.sqlToQuery(cond);
    let hit = sql.includes(`"line_link_sessions"."line_user_id" = $1`) && params[0] === s.lineUserId;
    const inList = sql.match(/"line_link_sessions"\."step" in \(([^)]+)\)/);
    if (inList) hit &&= (inList[1]!.split(",").map((p) => params[Number(p.trim().slice(1)) - 1]) as string[]).includes(s.step);
    if (/"line_link_sessions"\."muted_until" > \$/.test(sql)) hit &&= !!s.mutedUntil && s.mutedUntil > new Date();
    if (hit) Object.assign(s, set);
  };
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => ({ ...s })) as any));
  spies.push(spyOn(db, "update").mockImplementation(((table: any) => ({ set: (set: any) => ({ where: async (cond: any) => { if (getTableName(table) === "line_link_sessions") applySessionUpdate(set, cond); } }) })) as any));
  spies.push(spyOn(db, "insert").mockImplementation((() => ({ values: () => ({ onConflictDoUpdate: async () => {}, onConflictDoNothing: async () => {} }) })) as any));
  spies.push(spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })) as any)); // no family link
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => (opts.linked() ? { id: "t1", lineUserId: U, nickname: "KK", lineLang: "TH" } : undefined)) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(teacherLink, "requestTeacherLink").mockImplementation((async () => { calls.push("claim"); return opts.claim ?? "pending"; }) as any));
  spies.push(spyOn(checkinSvc, "findBookingsForTeacher").mockImplementation((async () => { calls.push("schedule"); return []; }) as any));
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { for (const x of m) replies.push(x.text); }) as any));
  return { s, replies, calls };
}
const typed = (text: string) => ({ type: "message", replyToken: "rt", source: { userId: U }, message: { type: "text", text } }) as any;
const HANDOVER_TH = t("handover_to_admin", "TH");

describe("🔴 TASK-520 — the whole story, by value: claim → approval → the coach's FIRST command is ANSWERED (it used to be handed over and muted)", () => {
  test("🔑 a QUEUED claim is not a strike and ENDS the linking conversation; after approval, `ตารางของฉัน` reaches the schedule — no hand-off, no mute", async () => {
    let linked = false;
    const w = world({}, { linked: () => linked });
    await handleLineWebhookEvents([typed("KK")]); // the nickname claim — queued for staff
    expect(w.calls).toEqual(["claim"]);
    expect([w.s.step, w.s.pendingRole, w.s.unexpectedCount, w.s.mutedUntil]).toEqual(["MUTED", null, 0, null]); // FLOW_CLEARED: no conversation, no strike, no mute
    expect(w.replies.some((r) => r.includes(HANDOVER_TH))).toBe(false);
    linked = true; // staff approve (the approval's own call is pinned below)
    await handleLineWebhookEvents([typed("ตารางของฉัน")]);
    expect(w.calls).toEqual(["claim", "schedule"]); // the command was ANSWERED
    expect(w.s.mutedUntil).toBeNull();
    expect(w.replies.some((r) => r.includes(HANDOVER_TH))).toBe(false);
  });

  test("…and a word typed WHILE WAITING for approval is not a second strike either (the same bug, earlier): an unlinked chat with no flow stays silent", async () => {
    const w = world({}, { linked: () => false });
    await handleLineWebhookEvents([typed("KK")]);
    await handleLineWebhookEvents([typed("สวัสดีครับ")]);
    expect(w.s.mutedUntil).toBeNull();
    expect(w.replies.some((r) => r.includes(HANDOVER_TH))).toBe(false);
  });

  test("🚫 a claim that did NOT queue (`not-found`) is still a failed attempt: strike 1, the chat stays at AWAIT_CODE to retype — unchanged", async () => {
    const w = world({}, { linked: () => false, claim: "not-found" });
    await handleLineWebhookEvents([typed("nobody")]);
    expect([w.s.step, w.s.pendingRole, w.s.unexpectedCount]).toEqual(["AWAIT_CODE", "teacher", 1]);
  });
});

describe("🔑 ending a link conversation can NEVER end a mute (TASK-477 §3 — pinned both ways)", () => {
  test("a chat under a REAL hand-off, still at a linking step: ending the conversation clears the step — the mute stays, and free text AND commands stay silenced", async () => {
    const until = new Date(Date.now() + 30 * 60_000);
    const w = world({ mutedUntil: until, unexpectedCount: 0 }, { linked: () => true });
    await endLinkingConversation(U); // what the approval does
    expect([w.s.step, w.s.mutedUntil]).toEqual(["MUTED", until]); // the flow ended — the mute did NOT
    await handleLineWebhookEvents([typed("hello"), typed("ตารางของฉัน")]);
    expect([w.replies, w.calls]).toEqual([[], []]); // a person is handling this chat: the bot says nothing
  });

  test("a chat in the ADD-STUDENT wizard (not a linking step) is untouched by it", async () => {
    const w = world({ step: "AWAIT_STUDENT_NAME", pendingRole: "customer", unexpectedCount: 1 }, { linked: () => true });
    await endLinkingConversation(U);
    expect([w.s.step, w.s.pendingRole, w.s.unexpectedCount]).toEqual(["AWAIT_STUDENT_NAME", "customer", 1]);
  });

  test("by value: its SQL — only `line_user_id = $1 and step in (the three linking steps)`; its SET has no `muted_until` column at all", async () => {
    let seen: any = null;
    const exec = { update: (_t: any) => ({ set: (set: any) => ({ where: async (cond: any) => { seen = { set, q: dialect.sqlToQuery(cond) }; } }) }) };
    await endLinkingConversation(U, exec);
    expect(seen.q.sql).toBe(`("line_link_sessions"."line_user_id" = $1 and "line_link_sessions"."step" in ($2, $3, $4))`);
    expect(seen.q.params).toEqual([U, "CHOOSE_ROLE", "AWAIT_CODE", "AWAIT_2FA"]);
    expect(Object.keys(seen.set).sort()).toEqual(["draft", "pendingRole", "step", "unexpectedCount", "updatedAt"]);
  });
});

describe("📌 by source — where a link is settled outside the chat, the conversation is ended", () => {
  const src = (f: string) => readFileSync(resolve(import.meta.dir, f), "utf8").replace(/\r\n/g, "\n");
  test("the staff APPROVAL ends it, after the grant", () => {
    const S = src("teacher-link.service.ts");
    const A = S.slice(S.indexOf("export async function approveTeacherLinkRequest("));
    expect(A.indexOf("await endLinkingConversation(request.lineUserId);")).toBeGreaterThan(A.indexOf(".set({ lineUserId: request.lineUserId })"));
  });
  test("the registration PAGE already did (TASK-347 Rule 4, `clearLinkSession` on all three of its doors) — which is why a parent is NOT affected", () => {
    const R = src("../routes/register.ts");
    expect((R.match(/await clearLinkSession\(who\.sub\)/g) ?? []).length).toBe(4); // 🔻 TASK-590: + the NEW family's create (the link is settled there now)
  });
});
