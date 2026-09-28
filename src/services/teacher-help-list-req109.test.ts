// TASK-485 (REQ-109 §6) — a linked TEACHER's Language/Help reply lists THEIR commands, byte for byte as the owner approved,
// and 🔑 THE LIST IS TRUE: every command it advertises actually routes for a teacher, typed AND tapped. The advertised words are
// read OUT OF THE LIST ITSELF, so a line added to it later without a command behind it fails here.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../db";
import { fakeDispatchBoundary } from "../test-support/line-dispatch-fakes"; // TASK-504 — the dispatcher's own un-mute write + family read, faked at the boundary
import { handleLineWebhookEvents } from "./line-webhook.service";
import * as checkinSvc from "./checkin.service";
import * as webApp from "../lib/web-app-link";
import * as lineClient from "../lib/line-client";
import { t } from "../lib/line-i18n";
import { CMD_SCHEDULE, RESERVED_WORDS } from "../lib/line-commands";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const U = "Uteacher0001";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

/** The approved copy (REQ-109 §6), whole — the reply a teacher reads after tapping ภาษา/ช่วยเหลือ. No blank line after the heading. */
const APPROVED = {
  TH: "เปลี่ยนเป็นภาษาไทยแล้ว ✅\n\nคำสั่งที่ใช้ได้:\n· ตารางของฉัน — ตารางสอนวันนี้ / สัปดาห์นี้\n· ปฏิทิน — ลิงก์เข้าเว็บ ดูตารางสอนบนมือถือ",
  EN: "Switched to English ✅\n\nAvailable Commands:\n· My Schedule — Today's / This week's schedule\n· Calendar — Link to the web app: your schedule on your phone",
};

/** A chat whose LINE user is a linked TEACHER (or a parent), in `lang`. Every read/write faked; the two teacher answers spied. */
const chat = (who: "teacher" | "parent", lang: "TH" | "EN") => {
  const replies: any[] = [];
  const calls: string[] = [];
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => undefined) as any));
  fakeDispatchBoundary(spies); // TASK-504
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => (who === "teacher" ? { id: "t1", lineUserId: U, nickname: "KK", lineLang: lang } : undefined)) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => (who === "parent" ? { id: "p1", lineUserId: U, lineLang: lang, status: "active", suspendedAt: null } : undefined)) as any));
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => (who === "parent" ? { parentId: "p1", lineUserId: U, lineLang: lang } : undefined)) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db, "update").mockImplementation((() => ({ set: () => ({ where: async () => {} }) })) as any));
  spies.push(spyOn(db, "insert").mockImplementation((() => ({ values: () => ({ onConflictDoUpdate: async () => {}, onConflictDoNothing: async () => {} }) })) as any));
  spies.push(spyOn(checkinSvc, "findBookingsForTeacher").mockImplementation((async () => { calls.push("schedule"); return []; }) as any));
  // 🔻 TASK-536 — the calendar command now sends the WEB APP link; "reached" is observed at its one builder (it mints no token any more).
  spies.push(spyOn(webApp, "webAppLink").mockImplementation((() => { calls.push("calendar"); return "https://app.example.test/?openExternalBrowser=1"; }) as any));
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { replies.push(...m); }) as any));
  return { replies, calls };
};
const tap = (data: string) => ({ type: "postback", replyToken: "rt", source: { userId: U }, postback: { data } }) as any;
const typed = (text: string) => ({ type: "message", replyToken: "rt", source: { userId: U }, message: { type: "text", text } }) as any;

describe("✅ the teacher's reply, byte for byte as approved (the toggle flips the language, so a TH chat answers in EN)", () => {
  for (const [from, to] of [["TH", "EN"], ["EN", "TH"]] as const) {
    test(`teacher, ${from} chat taps ภาษา/ช่วยเหลือ ⇒ the approved ${to} reply`, async () => {
      const c = chat("teacher", from);
      await handleLineWebhookEvents([tap("action=lang")]);
      expect(c.replies.map((r) => r.text)).toEqual([APPROVED[to]]);
    });
  }
  test("🚫 a PARENT's reply is unchanged (TASK-477's vocabulary)", async () => {
    const c = chat("parent", "EN");
    await handleLineWebhookEvents([tap("action=lang")]);
    expect(c.replies.map((r) => r.text)).toEqual(["เปลี่ยนเป็นภาษาไทยแล้ว ✅\n\nคำสั่งที่ใช้ได้:\n\n· เพิ่มนักเรียน — สูงสุด 5 คน\n· คอร์สของฉัน — คอร์สเรียนที่มี\n· เช็คอิน — ลงทะเบียนเข้าเรียน\n· แจ้งลา"]);
  });
});

describe("🔑 THE LIST IS TRUE — every command it advertises routes for a teacher (read out of the list itself)", () => {
  const advertised = (lang: "TH" | "EN") =>
    t("teacher_menu_body", lang).split("\n").filter((l) => l.startsWith("· ")).map((l) => l.slice(2).split(" — ")[0]!);
  test("the list advertises exactly two commands per language", () => {
    expect(advertised("TH")).toEqual(["ตารางของฉัน", "ปฏิทิน"]);
    expect(advertised("EN")).toEqual(["My Schedule", "Calendar"]);
  });
  const EXPECTED: Record<string, string> = { "ตารางของฉัน": "schedule", "My Schedule": "schedule", "ปฏิทิน": "calendar", "Calendar": "calendar" };
  for (const lang of ["TH", "EN"] as const) {
    test(`${lang}: each advertised word, TYPED by a teacher, reaches its answer (not silence)`, async () => {
      for (const word of advertised(lang)) {
        const c = chat("teacher", lang);
        await handleLineWebhookEvents([typed(word)]);
        expect({ word, reached: c.calls, replied: c.replies.length }).toEqual({ word, reached: [EXPECTED[word] ?? "NOTHING — this word is advertised but does not route"], replied: 1 });
        for (const s of spies.splice(0)) s.mockRestore();
      }
    });
  }
  test("…and TAPPED: the menu cell `ตารางของฉัน / My Schedule` fires `action=schedule` and answers", async () => {
    const c = chat("teacher", "TH");
    await handleLineWebhookEvents([tap("action=schedule")]);
    expect(c.calls).toEqual(["schedule"]);
    expect(c.replies.length).toBe(1);
  });
  test("\"This week's\" is true today: the schedule answer carries the week chip", async () => {
    const c = chat("teacher", "EN");
    await handleLineWebhookEvents([typed("my schedule")]);
    const chips = c.replies[0].quickReply.items.map((i: any) => i.action.data);
    expect(chips).toContain("action=schedule&range=week");
  });
});

describe("✅ ruling A — the two words are commands, and therefore reserved", () => {
  test("`CMD_SCHEDULE` and `RESERVED_WORDS` both carry them (a child cannot be nicknamed `my schedule`)", () => {
    for (const w of ["ตารางของฉัน", "my schedule"]) {
      expect({ w, command: (CMD_SCHEDULE as readonly string[]).includes(w), reserved: RESERVED_WORDS.includes(w) }).toEqual({ w, command: true, reserved: true });
    }
  });
});

// ───────────────────────── TASK-521 — `reopen` (the un-mute) reads the SAME decision: a teacher's list and a teacher's chips ─────────────────────────
describe("🔴 TASK-521 — the un-mute shows a TEACHER their own list and chips; a parent's is unchanged (one decision, every surface)", () => {
  const FUTURE = new Date(Date.now() + 30 * 60_000);
  /** The same chat, but MUTED (a hand-off in progress): the session read answers a live `mutedUntil`. */
  const mutedChat = (who: "teacher" | "parent", lang: "TH" | "EN") => {
    const c = chat(who, lang);
    spies[0]!.mockRestore(); // chat()'s first spy is the session read — replace it with a muted session
    spies[0] = spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => ({ lineUserId: U, step: "MUTED", mutedUntil: FUTURE, unexpectedCount: 0, updatedAt: new Date() })) as any);
    return c;
  };
  const chipsOf = (r: any) => r.quickReply.items.map((i: any) => [i.action.label, i.action.data]);

  for (const lang of ["TH", "EN"] as const) {
    test(`${lang}: a MUTED teacher types reopen ⇒ REQ-109 §6's list (the chat's language) + the teacher's three chips`, async () => {
      const c = mutedChat("teacher", lang);
      await handleLineWebhookEvents([typed("reopen")]);
      expect(c.replies.map((r) => r.text)).toEqual([t("teacher_menu_body", lang)]);
      expect(chipsOf(c.replies[0])).toEqual([[t("btn_today", lang), "action=schedule"], [t("btn_week", lang), "action=schedule&range=week"], [t("btn_calendar", lang), "action=calendar"]]);
    });
  }
  test("🚫 a MUTED parent types reopen ⇒ the parent list and the parent chips, unchanged", async () => {
    const c = mutedChat("parent", "EN");
    await handleLineWebhookEvents([typed("reopen")]);
    expect(c.replies.map((r) => r.text)).toEqual([t("menu_body", "EN")]);
    expect(chipsOf(c.replies[0]).map(([, d]: any) => d)).toEqual(["action=register", "action=mycourses", "action=checkin", "action=leave"]);
  });
  test("an UNMUTED teacher types reopen (the word the hand-off advertises to everyone) ⇒ their list, not silence", async () => {
    const c = chat("teacher", "EN");
    await handleLineWebhookEvents([typed("reopen")]);
    expect(c.replies.length).toBe(1);
    expect(c.replies[0].text).toContain(t("teacher_menu_body", "EN"));
    expect(chipsOf(c.replies[0]).map(([, d]: any) => d)).toEqual(["action=schedule", "action=schedule&range=week", "action=calendar"]);
  });
  test("🔑 every word the un-mute reply ADVERTISES routes for a teacher, typed — read out of the reply that was actually SENT", async () => {
    const m = mutedChat("teacher", "TH");
    await handleLineWebhookEvents([typed("reopen")]);
    const words = (m.replies[0].text as string).split("\n").filter((l) => l.startsWith("· ")).map((l) => l.slice(2).split(" — ")[0]!);
    expect(words).toEqual(["ตารางของฉัน", "ปฏิทิน"]);
    for (const s of spies.splice(0)) s.mockRestore();
    for (const word of words) {
      const c = chat("teacher", "TH");
      await handleLineWebhookEvents([typed(word)]);
      expect({ word, reached: c.calls }).toEqual({ word, reached: [word === "ปฏิทิน" ? "calendar" : "schedule"] });
      for (const s of spies.splice(0)) s.mockRestore();
    }
  });
  test("🔑 …and every CHIP under it, tapped by a teacher, answers (no chip is a parent's action)", async () => {
    const m = mutedChat("teacher", "EN");
    await handleLineWebhookEvents([typed("reopen")]);
    const datas: string[] = m.replies[0].quickReply.items.map((i: any) => i.action.data);
    for (const s of spies.splice(0)) s.mockRestore();
    for (const data of datas) {
      const c = chat("teacher", "EN");
      await handleLineWebhookEvents([tap(data)]);
      expect({ data, reached: c.calls }).toEqual({ data, reached: [data === "action=calendar" ? "calendar" : "schedule"] });
      for (const s of spies.splice(0)) s.mockRestore();
    }
  });
});
