// TASK-469 (REQ-107 §2) — the Sign Up and Add Student cells answer with the EXISTING `/register` LIFF link.
//
// 🔑 BEHAVIOUR through the real dispatcher (the TASK-447 harness: every DB read/write and the LINE reply faked), by
// value, both languages: what a parent receives with `LIFF_ID` set, what they receive without it, and that the typed
// phone still LINKS a family while the link is on offer — the fallback the owner ruled must keep working.
// 🔴 The id in these tests is a FAKE of the right shape. No real LIFF id appears anywhere in `src` (pinned below).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { liffLinkBody, liffUrl } from "../lib/liff-link";
import { handleLineWebhookEvents } from "./line-webhook.service";
import * as registerSvc from "./line-register.service";
import * as lineClient from "../lib/line-client";
import { db } from "../db";
import { tb } from "../lib/line-i18n";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const FAKE = "0000000000-FAKEfake";
const U = "Uaeeb9c20ca9";
const WORDS = "กรุณากดที่ลิ้งค์ด้านล่างเพื่อเพิ่มนักเรียนค่ะ\nPlease click the link below to add a student.";
// TASK-473 K0a — Sign Up's OWN words (REQ-107 §7); the link is the same.
const SIGNUP = "กรุณากดที่ลิ้งค์ด้านล่างเพื่อสมัครสมาชิกค่ะ\nPlease click the link below to sign up.";

const spies: Array<{ mockRestore: () => void }> = [];
const savedLiff = process.env.LIFF_ID;
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  if (savedLiff === undefined) delete process.env.LIFF_ID;
  else process.env.LIFF_ID = savedLiff;
});

/** The whole chat, faked — the same shape as `line-phone-in-silence-req105.test.ts`. */
const chat = (o: { linked?: "customer" | null } = {}) => {
  const replies: any[] = [];
  const writes: any[] = [];
  let session: any = null;
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => session ?? undefined) as any));
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => (o.linked === "customer" ? { id: "p1", lineUserId: U, lineLang: "TH", status: "active" } : undefined)) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => (o.linked === "customer" ? { parentId: "p1", lineUserId: U } : undefined)) as any));
  spies.push(spyOn(db, "insert").mockImplementation((() => ({
    values: (val: any) => ({ onConflictDoUpdate: async () => { writes.push({ op: "setStep", val }); session = { lineUserId: U, updatedAt: new Date(), mutedUntil: null, strikes: 0, draft: null, ...val }; }, onConflictDoNothing: async () => {} }),
  })) as any));
  spies.push(spyOn(db, "update").mockImplementation((() => ({ set: (patch: any) => ({ where: async () => { writes.push({ op: "update", patch }); } }) })) as any));
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, messages: any[]) => { replies.push(...messages); }) as any));
  return { replies, writes };
};
const tap = (data: string) => ({ type: "postback", replyToken: "rt", source: { userId: U }, postback: { data } }) as any;
const typed = (text: string) => ({ type: "message", replyToken: "rt", source: { userId: U }, message: { type: "text", text } }) as any;
const steps = (c: { writes: any[] }) => c.writes.filter((w) => w.op === "setStep").map((w) => w.val.step);

describe("🔑 the link comes from THIS box's `LIFF_ID` — never a literal", () => {
  test("by value: set ⇒ the customer's words (both languages) then the link once; unset or blank ⇒ null", () => {
    process.env.LIFF_ID = FAKE;
    expect(liffUrl()).toBe(`https://liff.line.me/${FAKE}`);
    expect(liffLinkBody("liff_add_student")).toBe(`${WORDS}\nhttps://liff.line.me/${FAKE}`);
    process.env.LIFF_ID = "  ";
    expect(liffLinkBody("liff_add_student")).toBeNull();
    delete process.env.LIFF_ID;
    expect(liffLinkBody("liff_add_student")).toBeNull();
  });
  test("🔴 a different box, a different page — the demo env and the real env each send their OWN id", () => {
    process.env.LIFF_ID = "1111111111-demoDEMO";
    expect(liffLinkBody("liff_add_student")).toEndWith("\nhttps://liff.line.me/1111111111-demoDEMO");
    process.env.LIFF_ID = "2222222222-realREAL";
    expect(liffLinkBody("liff_add_student")).toEndWith("\nhttps://liff.line.me/2222222222-realREAL");
  });
  test("the sheet's bytes (rows 41–42)", () => {
    expect(tb("liff_add_student")).toBe(WORDS);
  });
  test("🔴 no LIFF id or LIFF URL is written into `src` — every link is built from the env", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|json)$/.test(f)) {
          const s = readFileSync(p, "utf8");
          for (const m of s.matchAll(/\b\d{10}-[A-Za-z0-9]{8}\b|liff\.line\.me\/(?!\$\{|0000000000-FAKEfake|1111111111-demoDEMO|2222222222-realREAL)[A-Za-z0-9]/g)) {
            if (!/^(0000000000-FAKEfake|1111111111-demoDEMO|2222222222-realREAL)$/.test(m[0])) hits.push(`${p}: ${m[0].slice(0, 16)}…`);
          }
        }
      }
    };
    walk(resolve(root, "src"));
    walk(resolve(root, "scripts"));
    expect(hits).toEqual([]);
  });
});

describe("✅ SIGN UP (`action=enter`) — the link, not the phone question", () => {
  test("with `LIFF_ID`: one reply, SIGN UP's words (TASK-473 K0a) + the link, and 🚫 NO step set (the page does the linking)", async () => {
    process.env.LIFF_ID = FAKE;
    const c = chat({ linked: null });
    await handleLineWebhookEvents([tap("action=enter")]);
    expect(c.replies.map((r) => r.text)).toEqual([`${SIGNUP}\nhttps://liff.line.me/${FAKE}`]);
    expect(steps(c)).toEqual([]);
  });
  test("🔑 without `LIFF_ID`: exactly today's flow — the phone question and `AWAIT_CODE` + customer", async () => {
    delete process.env.LIFF_ID;
    const c = chat({ linked: null });
    await handleLineWebhookEvents([tap("action=enter")]);
    expect(c.replies.map((r) => r.text)).toEqual([tb("enter_ask_phone")]);
    expect(c.writes.filter((w) => w.op === "setStep").map((w) => w.val)).toEqual([{ lineUserId: U, step: "AWAIT_CODE", pendingRole: "customer" }]);
  });
});

describe("✅ ADD STUDENT (`action=register`, a linked parent) — the link, not the name prompt", () => {
  test("with `LIFF_ID`: the words + the link, 🚫 no step", async () => {
    process.env.LIFF_ID = FAKE;
    const c = chat({ linked: "customer" });
    await handleLineWebhookEvents([tap("action=register")]);
    expect(c.replies.map((r) => r.text)).toEqual([`${WORDS}\nhttps://liff.line.me/${FAKE}`]);
    expect(steps(c)).toEqual([]);
  });
  test("🔑 without `LIFF_ID`: today's in-chat flow — `AWAIT_STUDENT_NAME`", async () => {
    delete process.env.LIFF_ID;
    const c = chat({ linked: "customer" });
    await handleLineWebhookEvents([tap("action=register")]);
    expect(steps(c)).toEqual(["AWAIT_STUDENT_NAME"]);
    expect(c.replies).toHaveLength(1);
    expect(c.replies[0].text).toContain("กรุณาระบุชื่อนักเรียน");
  });
});

describe("🔴 THE FALLBACK — the typed phone still LINKS a family while the link is on offer (the owner's ruling)", () => {
  test("`LIFF_ID` set, an unlinked chat types its phone ⇒ `linkFamilyByPhone` runs and the `found` reply comes back", async () => {
    process.env.LIFF_ID = FAKE;
    const c = chat({ linked: null });
    const calls: any[] = [];
    spies.push(spyOn(registerSvc, "linkFamilyByPhone").mockImplementation((async (u: string, phone: string) => { calls.push([u, phone]); return { outcome: "found", isNew: false, children: [{ id: "s1", name: "KKTEST", nickname: "KK" }] }; }) as any));
    spies.push(spyOn(registerSvc, "settleLinkedRole").mockImplementation((async () => "TH") as any));
    await handleLineWebhookEvents([typed("0924912848")]);
    expect(calls).toEqual([[U, "0924912848"]]);
    expect(c.replies).toHaveLength(1);
    expect(c.replies[0].text).toContain("KK");
    expect(c.replies[0].text).not.toContain("liff.line.me"); // the typed door answers as it always did
  });
  test("`LIFF_ID` set, `สมัคร` still starts the typed registration (it is not rerouted to the link)", async () => {
    process.env.LIFF_ID = FAKE;
    const c = chat({ linked: null });
    await handleLineWebhookEvents([typed("สมัคร")]);
    expect(steps(c)).toEqual(["CHOOSE_ROLE"]);
    expect(c.replies.map((r) => r.text ?? "").join("")).not.toContain("liff.line.me");
  });
});
