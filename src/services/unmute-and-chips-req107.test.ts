// TASK-477 — Tanya's two leftovers from TEST-071, by value through the REAL dispatcher:
//  1. the un-mute (`เปิดเมนู` / `reopen`) answers in the CHAT's language, with the list's blank line after its heading;
//  2. the quick-reply chips are the MENU's four commands (Add Student · My Course · Check-in · Request Leave) — and the third
//     one now DOES "My Course" (`mycourses`), where it used to list children (`children`). A behaviour change, stated.
// And Sober's §3, written down as a rule: during a mute a TAP is answered; FREE TEXT is not.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleLineWebhookEvents } from "./line-webhook.service";
import * as lineClient from "../lib/line-client";
import { db } from "../db";
import { fakeFamilyLinks } from "../test-support/line-dispatch-fakes"; // TASK-504 — the dispatcher's family read, faked at the boundary
import { t, tb } from "../lib/line-i18n";
import { readSrc } from "../lib/read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(readSrc(readFileSync(resolve(root, "src/services/line-webhook.service.ts"), "utf8")));
const U = "Uaeeb9c20ca9";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

/** A LINKED parent in `lang`, optionally MUTED (the admin was called) — every read and write faked. */
const chat = (lang: "TH" | "EN", muted: boolean) => {
  const replies: any[] = [];
  const writes: any[] = [];
  const session = muted ? { lineUserId: U, step: null, pendingRole: null, draft: null, strikes: 0, updatedAt: new Date(), mutedUntil: new Date(Date.now() + 30 * 60_000) } : undefined;
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => session) as any));
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => ({ id: "p1", lineUserId: U, lineLang: lang, status: "active", suspendedAt: null })) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => ({ parentId: "p1", lineUserId: U, lineLang: lang })) as any));
  fakeFamilyLinks(spies, { [U]: "p1" }); // TASK-504 — the same family, answered at the `db.select` boundary `familyOfLineUser` really uses
  spies.push(spyOn(db, "insert").mockImplementation((() => ({ values: (val: any) => ({ onConflictDoUpdate: async () => { writes.push(val); }, onConflictDoNothing: async () => {} }) })) as any));
  spies.push(spyOn(db, "update").mockImplementation((() => ({ set: (patch: any) => ({ where: async () => { writes.push(patch); } }) })) as any));
  spies.push(spyOn(db, "delete").mockImplementation((() => ({ where: async () => { writes.push("delete"); } })) as any));
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { replies.push(...m); }) as any));
  return { replies, writes };
};
const typed = (text: string) => ({ type: "message", replyToken: "rt", source: { userId: U }, message: { type: "text", text } }) as any;
const tap = (data: string) => ({ type: "postback", replyToken: "rt", source: { userId: U }, postback: { data } }) as any;
const chips = (m: any) => m.quickReply.items.map((i: any) => [i.action.label, i.action.data, i.action.displayText]);

describe("✅ 1 — the un-mute answers in the CHAT's language, blank line after the heading", () => {
  test("TH chat: the TH list only, byte for byte", async () => {
    const c = chat("TH", true);
    await handleLineWebhookEvents([typed("เปิดเมนู")]);
    expect(c.replies.map((r) => r.text)).toEqual(["คำสั่งที่ใช้ได้:\n\n· เพิ่มนักเรียน — สูงสุด 5 คน\n· คอร์สของฉัน — คอร์สเรียนที่มี\n· เช็คอิน — ลงทะเบียนเข้าเรียน\n· แจ้งลา"]);
    expect(c.replies[0].text).not.toContain("Available Commands");
  });
  test("EN chat (`reopen`): the EN list only, byte for byte", async () => {
    const c = chat("EN", true);
    await handleLineWebhookEvents([typed("reopen")]);
    expect(c.replies.map((r) => r.text)).toEqual(["Available Commands:\n\n· Add Student — Up to 5\n· My Course — Registered Course\n· Check-in — Check in today's class\n· Request Leave"]);
  });
  test("🚫 nothing else changes: typed `เมนู` / Help outside a mute is still the bilingual list", async () => {
    const c = chat("TH", false);
    await handleLineWebhookEvents([typed("เมนู")]);
    expect(c.replies.map((r) => r.text)).toEqual([tb("menu_body")]);
  });
});

describe("🔴 2 — the chips are the MENU's four commands, in ONE list, and the third one DOES My Course", () => {
  test("TH, by value: label · the action it FIRES · what it sends", async () => {
    const c = chat("TH", true);
    await handleLineWebhookEvents([typed("เปิดเมนู")]);
    expect(chips(c.replies[0])).toEqual([
      ["เพิ่มนักเรียน", "action=register", "เพิ่มนักเรียน"],
      ["คอร์สของฉัน", "action=mycourses", "คอร์สของฉัน"],
      ["เช็คอิน", "action=checkin", "เช็คอิน"],
      ["แจ้งลา", "action=leave", "แจ้งลา"],
    ]);
  });
  test("EN, by value — and every label fits LINE's 20 characters", async () => {
    const c = chat("EN", false);
    await handleLineWebhookEvents([typed("menu")]);
    expect(chips(c.replies[0])).toEqual([
      ["Add Student", "action=register", "Add Student"],
      ["My Course", "action=mycourses", "My Course"],
      ["Check-in", "action=checkin", "Check-in"],
      ["Request Leave", "action=leave", "Request Leave"],
    ]);
    for (const [label] of chips(c.replies[0])) expect([...label].length).toBeLessThanOrEqual(20);
  });
  test("⚠️ the behaviour change, pinned: no chip fires `children` any more — but TYPING it still reaches the children list", () => {
    expect(SVC).not.toContain('"btn_children"');
    expect(SVC).not.toMatch(/\["btn_\w+", "children"\]/);
    expect(SVC).toContain("if (inList(CMD_CHILDREN, cmd)) {\n    return doChildren(lineUserId, replyToken, lang);");
  });
  test("ONE list: `PARENT_CHIPS` is the only chip set, and `parentActionItems` is built from it alone", () => {
    expect(SVC).toContain("return PARENT_CHIPS.map(([labelKey, action]) => mk(labelKey, action));");
    expect((SVC.match(/function parentActionItems/g) ?? []).length).toBe(1);
    expect((SVC.match(/parentActionItems\(lang\)/g) ?? []).length).toBe(1); // the one caller: doMenu
    expect([t("btn_mycourses", "TH"), t("btn_mycourses", "EN")]).toEqual(["คอร์สของฉัน", "My Course"]);
  });
});

describe("📌 §3 — during a mute a TAP is answered and FREE TEXT is not (the design, written down)", () => {
  test("muted: a menu TAP answers", async () => {
    const c = chat("TH", true);
    await handleLineWebhookEvents([tap("action=menu")]);
    expect(c.replies.length).toBe(1);
    expect(c.replies[0].text).toBe(tb("menu_body"));
  });
  test("muted: free text gets NOTHING (the admin is answering it)", async () => {
    const c = chat("TH", true);
    await handleLineWebhookEvents([typed("สวัสดีค่ะ มีคำถามค่ะ")]);
    expect(c.replies).toEqual([]);
  });
  test("by source: the postback path has no mute gate — the gate lives only on the message path", () => {
    const pb = SVC.slice(SVC.indexOf("async function handlePostback"), SVC.indexOf("\n}\n", SVC.indexOf("async function handlePostback")));
    expect(pb).not.toMatch(/mutedUntil|isMuted|route === "muted"/);
    expect(SVC).toContain('if (route === "muted") {');
  });
});
