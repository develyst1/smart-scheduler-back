// TASK-485 (REQ-109 §6) — a linked TEACHER's Language/Help reply lists THEIR commands, byte for byte as the owner approved,
// and 🔑 THE LIST IS TRUE: every command it advertises actually routes for a teacher, typed AND tapped. The advertised words are
// read OUT OF THE LIST ITSELF, so a line added to it later without a command behind it fails here.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../db";
import { fakeDispatchBoundary } from "../test-support/line-dispatch-fakes"; // TASK-504 — the dispatcher's own un-mute write + family read, faked at the boundary
import { handleLineWebhookEvents } from "./line-webhook.service";
import * as checkinSvc from "./checkin.service";
import * as calendarSvc from "./calendar.service";
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
  TH: "เปลี่ยนเป็นภาษาไทยแล้ว ✅\n\nคำสั่งที่ใช้ได้:\n· ตารางของฉัน — ตารางสอนวันนี้ / สัปดาห์นี้\n· ปฏิทิน — ลิงก์ปฏิทินสอนทั้งหมด",
  EN: "Switched to English ✅\n\nAvailable Commands:\n· My Schedule — Today's / This week's schedule\n· Calendar — Link to your full teaching calendar",
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
  spies.push(spyOn(calendarSvc, "getCalendarTokenForLineUser").mockImplementation((async () => { calls.push("calendar"); return "cal-token"; }) as any));
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
