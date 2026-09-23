// TASK-449 (`REQ-105 §7`) — the PROVEN cause of Khwan's silence, and the rule that ends the whole class.
//
// The `sid` log: three times, after `action=enter`, `update parents set line_user_id = … where id = … and line_user_id
// is null` threw `23505 parents_line_user_id_uq`, the dispatcher's catch logged it, and **nothing was sent**. So:
//   (b) no event may end in silence because something threw — a handler that throws now answers with ONE generic
//       bilingual sentence and still logs (a failed apology is logged and swallowed, never masking the first error);
//   (a) the collision is refused with the EXISTING words: the guard reads BOTH stores in one read taken BEFORE any
//       write (a link row must not blind the column guard), and the `23505` itself maps to the same outcome.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bindFamilyLine, holdersOfLineUser } from "../lib/family-link";
import { t } from "../lib/line-i18n";
import { handleLineWebhookEvents } from "./line-webhook.service";
import { linkParentLine } from "./parent.service";
import * as registerSvc from "./line-register.service";
import * as lineClient from "../lib/line-client";
import { db } from "../db";
import { readSrc } from "../lib/read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/line-webhook.service.ts"));
const U = "Uf6ca16e92110e76e42a8f923a9572b4b"; // the account from the log
const A = "d8238b86-0000-4000-8000-000000000001"; // the parent the phone found
const B = "d8238b86-0000-4000-8000-000000000002"; // the parent that still holds the COLUMN
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
const pg23505 = () => Object.assign(new Error('duplicate key value violates unique constraint "parents_line_user_id_uq"'), { code: "23505" });

describe("🔴 (b) no webhook event ends in silence because something threw", () => {
  const eventChat = (o: { throws?: unknown } = {}) => {
    const replies: any[] = [];
    const logs: string[] = [];
    spies.push(spyOn(console, "error").mockImplementation(((...a: any[]) => { logs.push(a.map(String).join(" ")); }) as any));
    spies.push(spyOn(console, "info").mockImplementation((() => {}) as any));
    spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => { if (o.throws) throw o.throws; return undefined; }) as any));
    spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { replies.push(...m); }) as any));
    return { replies, logs };
  };
  const msg = (over: any = {}) => ({ type: "message", replyToken: "rt-1", source: { userId: U }, message: { type: "text", text: "0924912848" }, ...over }) as any;

  test("🔴 THE DEFECT: a handler that throws `23505` now produces exactly ONE reply — the generic sentence — and still logs", async () => {
    const c = eventChat({ throws: pg23505() });
    await handleLineWebhookEvents([msg()]);
    expect(c.replies).toHaveLength(1);
    expect(c.replies[0]).toEqual({ type: "text", text: `${t("generic_error", "TH")}\n${t("generic_error", "EN")}` });
    expect(c.replies[0].text).toContain("ขออภัย ระบบมีปัญหาชั่วคราว กรุณาติดต่อแอดมิน");
    expect(c.logs.filter((l) => l.includes("[line-webhook] event error"))).toHaveLength(1);
    expect(c.logs.some((l) => l.includes("parents_line_user_id_uq"))).toBe(true); // the cause is still in the log
  });
  test("any throw answers, not just a pg error — and a handler that does NOT throw is untouched", async () => {
    for (const thrown of [new Error("boom"), "a string", { weird: true }]) {
      const c = eventChat({ throws: thrown });
      await handleLineWebhookEvents([msg()]);
      expect({ thrown: String(thrown), replies: c.replies.length }).toEqual({ thrown: String(thrown), replies: 1 });
      for (const s of spies.splice(0)) s.mockRestore();
    }
    const clean = eventChat();
    await handleLineWebhookEvents([msg({ message: { type: "text", text: "สวัสดี" } })]); // AC-16: silence, and nothing threw
    expect(clean.replies).toEqual([]);
    expect(clean.logs).toEqual([]);
  });
  test("no reply token ⇒ nothing is answered and nothing is invented (the handler returns before it can even throw)", async () => {
    const c = eventChat({ throws: pg23505() });
    await handleLineWebhookEvents([msg({ replyToken: undefined })]);
    expect(c.replies).toEqual([]);
    expect(c.logs).toEqual([]); // `handleMessage` exits on the missing token first — there is no error to log and no one to tell
    expect(SVC.slice(SVC.indexOf("export async function handleLineWebhookEvents"))).toContain("if (ev.replyToken) {"); // …and the catch asks before it speaks
  });
  test("🚫 a failed apology is logged and swallowed — it never masks the first error, and never throws out of the dispatcher", async () => {
    const c = eventChat({ throws: pg23505() });
    spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async () => { throw new Error("LINE 500"); }) as any));
    await expect(handleLineWebhookEvents([msg()])).resolves.toBeUndefined();
    expect(c.logs.filter((l) => l.includes("[line-webhook] event error"))).toHaveLength(1);
    expect(c.logs.filter((l) => l.includes("[line-webhook] apology failed"))).toHaveLength(1);
  });
  test("by source: the reply sits INSIDE the dispatcher's catch, bilingual, guarded by the token", () => {
    const D = SVC.slice(SVC.indexOf("export async function handleLineWebhookEvents"));
    expect(D).toContain('console.error("[line-webhook] event error:", e);');
    expect(D).toContain("if (ev.replyToken) {");
    expect(D).toContain('await replyMessage(ev.replyToken, [{ type: "text", text: tb("generic_error") }]);');
    expect(D).toContain('console.error("[line-webhook] apology failed:", e2);');
    expect(D.indexOf("event error")).toBeLessThan(D.indexOf("ev.replyToken")); // logged first, then answered
  });
});

describe("🔴 (a) the collision — one read of BOTH stores before any write, and the 23505 mapped to the same words", () => {
  /** `family_line_links` holds `link`; `parents.line_user_id` holds `column`. Either may be null. */
  const holderExec = (o: { link?: string | null; column?: string | null }, writes: any[] = []) => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (o.link ? [{ parentId: o.link }] : []) }) }) }),
    query: { parents: { findFirst: async () => (o.column ? { id: o.column } : undefined) } },
    insert: () => ({ values: (v: any) => ({ onConflictDoNothing: async () => { writes.push(v); } }) }),
  }) as any;

  test("`holdersOfLineUser` reads BOTH stores — the link row, the column, both, neither", async () => {
    expect(await holdersOfLineUser(U, holderExec({ link: A, column: B }))).toEqual({ linkParentId: A, columnParentId: B, all: [A, B] });
    expect(await holdersOfLineUser(U, holderExec({ link: null, column: B }))).toEqual({ linkParentId: null, columnParentId: B, all: [B] });
    expect(await holdersOfLineUser(U, holderExec({ link: A, column: null }))).toEqual({ linkParentId: A, columnParentId: null, all: [A] });
    expect(await holdersOfLineUser(U, holderExec({}))).toEqual({ linkParentId: null, columnParentId: null, all: [] });
    expect(await holdersOfLineUser(U, holderExec({ link: A, column: A }))).toEqual({ linkParentId: A, columnParentId: A, all: [A] }); // one holder, not two
  });
  test("🔴 THE BLINDING: a link row for THIS parent while ANOTHER parent holds the column ⇒ refused, nothing inserted", async () => {
    const writes: any[] = [];
    expect(await bindFamilyLine(A, U, holderExec({ link: A, column: B }, writes))).toEqual({ ok: false, reason: "bound-to-other-family" });
    expect(writes).toEqual([]); // the guard is BEFORE the insert
    // the ordinary cases still behave: a clean account binds, the same family re-binds, another family is refused
    expect(await bindFamilyLine(A, U, holderExec({}, writes))).toEqual({ ok: true, alreadyBound: false });
    expect(writes).toEqual([{ parentId: A, lineUserId: U }]);
    expect(await bindFamilyLine(A, U, holderExec({ link: A, column: A }, writes))).toEqual({ ok: true, alreadyBound: true });
    expect(await bindFamilyLine(A, U, holderExec({ link: B }, writes))).toEqual({ ok: false, reason: "bound-to-other-family" });
    expect(await bindFamilyLine(A, U, holderExec({ column: B }, writes))).toEqual({ ok: false, reason: "bound-to-other-family" });
  });
  test("🔴 `linkParentLine` reads the COLUMN (not 'whose family is this chat'), and maps a racing 23505 to the SAME sentence", async () => {
    const exec = (o: { column?: string | null; throwOnUpdate?: unknown }) => ({
      query: { parents: { findFirst: async ({ columns }: any) => (columns?.id && o.column ? { id: o.column } : o.column === undefined && !columns ? undefined : o.column ? { id: o.column } : undefined) } },
      update: () => ({ set: () => ({ where: async () => { if (o.throwOnUpdate) throw o.throwOnUpdate; } }) }),
    }) as any;
    const active = (e: any) => Object.assign(e, { query: { ...e.query, parents: { ...e.query.parents, findFirst: e.query.parents.findFirst } } });
    // another parent holds the column ⇒ the refusal, before the write
    await expect(linkParentLine(A, U, active(exec({ column: B })))).rejects.toMatchObject({ status: 400, message: "LINE นี้ผูกกับผู้ปกครองรายอื่นแล้ว" });
    // the race: the guard saw nothing, the index did ⇒ the same sentence, never a raw 23505
    await expect(linkParentLine(A, U, active(exec({ column: null, throwOnUpdate: pg23505() })))).rejects.toMatchObject({ status: 400, message: "LINE นี้ผูกกับผู้ปกครองรายอื่นแล้ว" });
    // any other failure is NOT swallowed into a friendly sentence
    await expect(linkParentLine(A, U, active(exec({ column: null, throwOnUpdate: new Error("connection lost") })))).rejects.toThrow("connection lost");
    // the happy path writes
    await expect(linkParentLine(A, U, active(exec({ column: null })))).resolves.toBeUndefined();
  });
  test("by source: the guard reads the column directly; the register path maps the refusal to the EXISTING outcome (no new words, no re-pointing)", () => {
    const P = code(src("src/services/parent.service.ts"));
    const L = P.slice(P.indexOf("export async function linkParentLine"));
    const BODY = L.slice(0, L.indexOf("\n}\n"));
    expect(BODY).toContain("const owner = await exec.query.parents.findFirst({");
    expect(BODY).not.toContain("findParentByLineUserId(lineUserId, exec)"); // the blinding read is gone from THIS guard
    expect(BODY).toContain('if (pgErrorCode(e) === "23505") throw badRequest("LINE นี้ผูกกับผู้ปกครองรายอื่นแล้ว");');
    expect(BODY.indexOf("const owner")).toBeLessThan(BODY.indexOf(".update(parents)"));
    const R = code(src("src/services/line-register.service.ts"));
    expect(R).toContain('if (e instanceof ApiException && e.status === 400) return { outcome: "line-bound-to-other-family" };');
    expect((R.match(/outcome: "line-bound-to-other-family"/g) ?? []).length).toBe(6); // the type + the page pre-check ×2 + the bind + this map + the new-phone guard — ONE set of words for one meaning
    expect(R).not.toMatch(/set\(\{ lineUserId \}\)/); // 🚫 nothing here re-points an account at another family
    expect(t("verify_parent_other_family", "TH")).toContain("ผูกกับอีกครอบครัว");
  });
  test("end to end: the customer's exact sequence answers with the refusal instead of silence", async () => {
    const replies: any[] = [];
    spies.push(spyOn(console, "error").mockImplementation((() => {}) as any));
    spies.push(spyOn(console, "info").mockImplementation((() => {}) as any));
    spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => ({ lineUserId: U, step: "AWAIT_CODE", pendingRole: "customer", updatedAt: new Date(), mutedUntil: null, strikes: 0, draft: null })) as any));
    spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db, "update").mockImplementation((() => ({ set: () => ({ where: async () => {} }) })) as any));
    spies.push(spyOn(db, "insert").mockImplementation((() => ({ values: () => ({ onConflictDoUpdate: async () => {}, onConflictDoNothing: async () => {} }) })) as any));
    spies.push(spyOn(registerSvc, "linkFamilyByPhone").mockImplementation((async () => ({ outcome: "line-bound-to-other-family" })) as any));
    spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { replies.push(...m); }) as any));
    await handleLineWebhookEvents([{ type: "message", replyToken: "rt-1", source: { userId: U }, message: { type: "text", text: "0924912848" } } as any]);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toContain(t("verify_parent_other_family", "TH"));
    expect(replies[0].text).not.toContain(t("generic_error", "TH")); // a HANDLED collision is not an internal error
  });
});
