// TASK-447 (`REQ-105 §7`) — the customer typed her phone twice and the bot said NOTHING. The cause is not the link
// code (every `linkFamilyByPhone` outcome already replies) but the door: AC-16 silences an UNLINKED chat with no
// session, and the greeting that asked her for the phone is **the OA's own auto-greeting** — our `follow` dispatch is
// dead by the owner's ruling — so LINE asked a question nothing was listening for (DEF-9's shape, one door further on).
//
// This pins the fix BY VALUE through the real dispatcher (`handleLineWebhookEvents`) over fake DB reads: a phone-shaped
// text from an unlinked, un-muted chat with no session adopts the EXACT state the `เข้าใช้ระบบ` button sets
// (`AWAIT_CODE` + `pendingRole: "customer"`) and falls through to the ONE handler, so every outcome answers; anything
// else still gets silence; a MUTED chat still gets silence; a linked chat is untouched. Plus the purity of
// `isPhoneShaped` and the two diagnosis facts the TASK asks for (the `Help` cell's postback; the mute's expiry).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isPhoneShaped, normalizePhone } from "./parent.service";
import { KNOWN_RICH_MENU, KNOWN_RICH_MENU_EN } from "../lib/line-rich-menu";
import { MUTE_MINUTES, decideMessageRoute, isMuted, muteUntilFrom } from "../lib/line-routing";
import { handleLineWebhookEvents } from "./line-webhook.service";
import * as registerSvc from "./line-register.service";
import * as lineClient from "../lib/line-client";
import { db } from "../db";
import { fakeFamilyLinks } from "../test-support/line-dispatch-fakes"; // TASK-504 — the dispatcher's family read, faked at the boundary
import { readSrc } from "../lib/read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/line-webhook.service.ts"));
const U = "Uaeeb9c20ca9";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

/** The whole chat, faked: the session row, the two "is this chat linked?" reads, the writes, and the replies. */
const chat = (o: { session?: any; linked?: "customer" | "teacher" | null } = {}) => {
  const replies: any[] = [];
  const writes: any[] = [];
  let session = o.session ?? null;
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => session ?? undefined) as any));
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => (o.linked === "teacher" ? { id: "t1", lineUserId: U } : undefined)) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => (o.linked === "customer" ? { id: "p1", lineUserId: U, lineLang: "TH" } : undefined)) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any)); // no admins, no settings
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => (o.linked === "customer" ? { parentId: "p1", lineUserId: U } : undefined)) as any));
  fakeFamilyLinks(spies, o.linked === "customer" ? { [U]: "p1" } : {}); // TASK-504 — the SAME family, at the `db.select` boundary `familyOfLineUser` really uses
  spies.push(spyOn(db, "insert").mockImplementation(((table: any) => ({
    values: (val: any) => ({ onConflictDoUpdate: async () => { writes.push({ op: "setStep", val }); session = { lineUserId: U, updatedAt: new Date(), mutedUntil: null, strikes: 0, draft: null, ...val }; }, onConflictDoNothing: async () => {} }),
  })) as any));
  spies.push(spyOn(db, "update").mockImplementation((() => ({ set: (patch: any) => ({ where: async () => { writes.push({ op: "update", patch }); } }) })) as any));
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_token: string, messages: any[]) => { replies.push(...messages); }) as any));
  return { replies, writes, get session() { return session; } };
};
const textEvent = (text: string) => ({ type: "message", replyToken: "rt", source: { userId: U }, message: { type: "text", text } }) as any;

describe("🔴 `isPhoneShaped` — a number typed ALONE, and nothing else", () => {
  test("by value: the shapes a parent types, the shapes that must stay silent", () => {
    for (const ok of ["0924912848", " 0924912848 ", "092-491-2848", "092 491 2848", "(092) 491-2848", "+66924912848", "66924912848"]) {
      expect({ ok, shaped: isPhoneShaped(ok) }).toEqual({ ok, shaped: true });
    }
    for (const no of ["", "   ", "สวัสดีค่ะ", "เมนู", "menu", "KKTEST", "สวัสดีค่ะ 0924912848", "0924912848 ค่ะ", "12345678", "092491284a", "1", "ครู"]) {
      expect({ no, shaped: isPhoneShaped(no) }).toEqual({ no, shaped: false });
    }
    // the floor is `linkFamilyByPhone`'s own (`phone.length < 9` ⇒ `phone-invalid`), read off the same normalizer
    expect(normalizePhone("092-491-2848")).toBe("0924912848");
    expect(code(src("src/services/line-register.service.ts"))).toContain('if (phone.length < 9) return { outcome: "phone-invalid" };');
    expect(isPhoneShaped("123456789")).toBe(true); // 9 digits: the link path decides, and it answers either way
  });
});

describe("🔴 the door by VALUE through the real dispatcher", () => {
  test("🔴 THE DEFECT: a phone from an unlinked chat with NO session is no longer silence — it opens `AWAIT_CODE`+customer and the link reply comes back", async () => {
    const c = chat({ session: null, linked: null });
    const calls: any[] = [];
    spies.push(spyOn(registerSvc, "linkFamilyByPhone").mockImplementation((async (lineUserId: string, phone: string) => { calls.push([lineUserId, phone]); return { outcome: "found", isNew: false, children: [{ id: "s1", name: "KKTEST", nickname: "KK" }] }; }) as any));
    spies.push(spyOn(registerSvc, "settleLinkedRole").mockImplementation((async () => "TH") as any));
    await handleLineWebhookEvents([textEvent("0924912848")]);
    expect(calls).toEqual([[U, "0924912848"]]); // the SAME call the `เข้าใช้ระบบ` button's step makes
    expect(c.writes.filter((w) => w.op === "setStep")[0]!.val).toEqual({ lineUserId: U, step: "AWAIT_CODE", pendingRole: "customer" }); // FIRST: the door adopts the button's pair, then the ordinary flow continues
    expect(c.replies).toHaveLength(1);
    expect(c.replies[0].type).toBe("text");
    expect(c.replies[0].text).toContain("KK"); // her child's name — the `found` outcome's own words
    expect(c.replies[0].text.trim().length).toBeGreaterThan(0);
  });
  test("every other outcome ANSWERS too — bad phone · archived · bound elsewhere (the silence was never the link code)", async () => {
    for (const outcome of ["phone-invalid", "phone-archived", "phone-bound-to-other-line", "line-bound-to-other-family"] as const) {
      const c = chat({ session: null, linked: null });
      spies.push(spyOn(registerSvc, "linkFamilyByPhone").mockImplementation((async () => ({ outcome })) as any));
      await handleLineWebhookEvents([textEvent("0924912848")]);
      expect({ outcome, replies: c.replies.length }).toEqual({ outcome, replies: 1 });
      expect({ outcome, empty: !c.replies[0]?.text?.trim() }).toEqual({ outcome, empty: false });
      for (const s of spies.splice(0)) s.mockRestore();
    }
  });
  test("🚫 AC-16 is otherwise UNCHANGED: `สวัสดี` · `เมนู` · a nickname · a number inside a sentence ⇒ still nothing, and no session is opened", async () => {
    for (const text of ["สวัสดีค่ะ", "เมนู", "KKTEST", "สวัสดีค่ะ 0924912848", "12345678"]) {
      const c = chat({ session: null, linked: null });
      const link = spyOn(registerSvc, "linkFamilyByPhone").mockImplementation((async () => ({ outcome: "found", isNew: false, children: [] })) as any);
      spies.push(link);
      await handleLineWebhookEvents([textEvent(text)]);
      expect({ text, replies: c.replies.length, writes: c.writes.length }).toEqual({ text, replies: 0, writes: 0 });
      expect(link).not.toHaveBeenCalled();
      for (const s of spies.splice(0)) s.mockRestore();
    }
  });
  test("🚫 a MUTED chat stays silent on the same phone — the owner's rule is untouched (the gate returns before the door)", async () => {
    const c = chat({ session: { lineUserId: U, step: "MUTED_STEP", pendingRole: null, mutedUntil: new Date(Date.now() + 30 * 60_000), updatedAt: new Date(), strikes: 0, draft: null }, linked: null });
    const link = spyOn(registerSvc, "linkFamilyByPhone").mockImplementation((async () => ({ outcome: "found", isNew: false, children: [] })) as any);
    spies.push(link);
    await handleLineWebhookEvents([textEvent("0924912848")]);
    expect(c.replies).toEqual([]);
    expect(c.writes).toEqual([]);
    expect(link).not.toHaveBeenCalled();
    expect(decideMessageRoute(undefined, null, { mutedUntil: new Date(Date.now() + 60_000) })).toBe("muted");
  });
  test("🚫 a LINKED chat is untouched: the same phone text from a linked customer reaches the parent commands, not the link door", async () => {
    const c = chat({ session: null, linked: "customer" });
    const link = spyOn(registerSvc, "linkFamilyByPhone").mockImplementation((async () => ({ outcome: "found", isNew: false, children: [] })) as any);
    spies.push(link);
    await handleLineWebhookEvents([textEvent("0924912848")]);
    expect(link).not.toHaveBeenCalled();
    expect(c.writes.filter((w) => w.op === "setStep")).toEqual([]);
    expect(decideMessageRoute(undefined, "customer")).toBe("linked");
  });
  test("by source: ONE call site, no new step, no second phone flow — the branch sets the SAME pair `action=enter` sets and falls through", () => {
    expect(SVC).toContain('if (route === "silence") {');
    expect(SVC).toContain("if (!isPhoneShaped(text)) return;");
    expect((SVC.match(/await setStep\(lineUserId, "AWAIT_CODE", "customer"\);/g) ?? []).length).toBe(2); // the `enter` button + this door, the same pair
    expect((SVC.match(/verifyAndLink\(/g) ?? []).length).toBe(2); // its declaration and the ONE handler — no second caller
    expect(SVC).toContain('if (session.step === "AWAIT_CODE" && session.pendingRole) {');
    expect(SVC).not.toContain("handleFollow(ev)"); // the owner's ruling stands: `follow` is still not dispatched
  });
});

describe("🔎 the diagnosis the TASK asks for — the `Help` cell, and how a muted chat comes back", () => {
  test("🔴 the old EN menu's 6th cell IS `action=admin` ⇒ one tap on `Help` mutes the chat for an hour — that is \"the bot often ignores her commands\"", () => {
    expect(KNOWN_RICH_MENU.areas[5]!.action).toMatchObject({ data: "action=admin" });
    expect(KNOWN_RICH_MENU_EN.areas).toEqual(KNOWN_RICH_MENU.areas); // the EN menu SHARES the TH areas — only its image says `Help`
    expect(code(src("src/services/line-webhook.service.ts"))).toContain('if (action === "admin") return doCallAdmin(lineUserId, replyToken, lang);');
    const D = SVC.slice(SVC.indexOf("async function doCallAdmin"));
    expect(D.slice(0, D.indexOf("\n}\n"))).toContain("muteUntilFrom()");
  });
  test("the mute EXPIRES — 60 minutes, and `เปิดเมนู` is the early way back; it is not a bot that never returns", () => {
    expect(MUTE_MINUTES).toBe(60);
    const now = new Date("2026-09-23T12:00:00Z");
    expect(muteUntilFrom(now).toISOString()).toBe("2026-09-23T13:00:00.000Z");
    expect(isMuted(muteUntilFrom(now), new Date("2026-09-23T12:59:00Z"))).toBe(true);
    expect(isMuted(muteUntilFrom(now), new Date("2026-09-23T13:00:01Z"))).toBe(false);
    expect(SVC).toContain("if (isReopenWord(lower)) {");
  });
});
