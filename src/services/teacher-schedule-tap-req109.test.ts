// TASK-486 (REQ-109 §6) — the tap, through the REAL dispatcher: `ตารางของฉัน` answers TODAY, in the chat's language, with the
// pair `วันนี้` / `สัปดาห์นี้` (which REPLACES the old single toggle) and the calendar chip beside them; the week chip answers the
// week in Khwan's format.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { db } from "../db";
import { fakeDispatchBoundary } from "../test-support/line-dispatch-fakes"; // TASK-504 — the dispatcher's own un-mute write + family read, faked at the boundary
import { handleLineWebhookEvents } from "./line-webhook.service";
import * as checkinSvc from "./checkin.service";
import * as lineClient from "../lib/line-client";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const U = "Uteacher0002";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

const teacherChat = (lang: "TH" | "EN", rows: any[]) => {
  const replies: any[] = [];
  const asked: Array<[string, string]> = [];
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => undefined) as any));
  fakeDispatchBoundary(spies); // TASK-504
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => ({ id: "t1", lineUserId: U, nickname: "KK", lineLang: lang })) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(checkinSvc, "findBookingsForTeacher").mockImplementation((async (_u: string, from: string, to: string) => { asked.push([from, to]); return rows; }) as any));
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { replies.push(...m); }) as any));
  setSystemTime(new Date("2026-09-25T09:00:00+07:00")); // a Friday
  return { replies, asked };
};
const tap = (data: string) => ({ type: "postback", replyToken: "rt", source: { userId: U }, postback: { data } }) as any;
const ROWS = [
  { date: "2026-09-25", startTime: "10:00:00", status: "PENDING", student: { name: "ส้ม", nickname: "ส้ม" }, coStudent: null, otherTitle: null, subject: { name: "Private FREESKATE" }, attendeeNote: null },
  { date: "2026-09-26", startTime: "16:00:00", status: "CONFIRMED", student: { name: "Anya", nickname: "Anya" }, coStudent: null, otherTitle: null, subject: { name: "Private ONEWHEEL E-SKATE" }, attendeeNote: null },
];

describe("✅ the tap answers TODAY, with the pair of chips", () => {
  test("EN: today's rows only, Khwan's format, then chips Today · This week · the calendar", async () => {
    const c = teacherChat("EN", [ROWS[0]]);
    await handleLineWebhookEvents([tap("action=schedule")]);
    expect(c.asked).toEqual([["2026-09-25", "2026-09-25"]]);
    expect(c.replies[0].text).toBe("⏱️TODAY'S SCHEDULE:\n\n▸ FRI / 25/09\n@ 10:00 / ส้ม\n　FREESKATE / Pending");
    expect(c.replies[0].quickReply.items.map((i: any) => [i.action.label, i.action.data])).toEqual([
      ["Today", "action=schedule"],
      ["This week", "action=schedule&range=week"],
      ["My calendar", "action=calendar"],
      ["‹ Menu", "action=menu"],
    ]);
  });
  // 🔨 TASK-493 — MOVED: the schedule's words are ENGLISH in a Thai chat too (the owner, for Khwan: her coaches' readability).
  // The CHIPS are not the schedule — they are the chat's buttons, and they still follow the chat's language.
  test("TH chat: the SAME English schedule (TASK-493, the customer's choice) — only the chips are in Thai", async () => {
    const c = teacherChat("TH", [ROWS[0]]);
    await handleLineWebhookEvents([tap("action=schedule")]);
    expect(c.replies[0].text).toBe("⏱️TODAY'S SCHEDULE:\n\n▸ FRI / 25/09\n@ 10:00 / ส้ม\n　FREESKATE / Pending");
    expect(c.replies[0].quickReply.items.slice(0, 2).map((i: any) => i.action.label)).toEqual(["วันนี้", "สัปดาห์นี้"]);
  });
  // 🔑 TASK-493 — the customer's ruling as an EQUALITY, through the real dispatcher: a Thai chat's schedule text is
  // byte-identical to an English chat's — rows, the empty case and the overflow line alike. Only the chips differ.
  test("🔑 a THAI chat's schedule text is BYTE-IDENTICAL to an English chat's — with rows, and with NOTHING to show", async () => {
    for (const rows of [[ROWS[0]], []]) {
      const texts: string[] = [];
      for (const lang of ["TH", "EN"] as const) {
        const c = teacherChat(lang, rows);
        await handleLineWebhookEvents([tap("action=schedule")]);
        texts.push(c.replies[0].text);
        for (const s of spies.splice(0)) s.mockRestore();
      }
      expect(texts[0]).toBe(texts[1]!);
    }
  });
  test("the week chip ⇒ the WEEK (Mon–Sun), Khwan's header, a PENDING row NOT shown in the week", async () => {
    const c = teacherChat("EN", ROWS);
    await handleLineWebhookEvents([tap("action=schedule&range=week")]);
    expect(c.asked).toEqual([["2026-09-21", "2026-09-27"]]);
    expect(c.replies[0].text).toBe("⏱️ THIS WEEK'S SCHEDULE\n\n▸ SAT / 26/09\n@ 16:00 / Anya\n　ONEWHEEL E-SKATE / Confirmed");
  });
});
