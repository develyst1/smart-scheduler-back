// TASK-536 (owner ruling 09-28: "ส่งลิ้งไป ให้ครูล็อกอินเอง แล้วเข้าไปใช้เว็บ แบบบนมือถือ แค่นั้น") — `ปฏิทิน` / `calendar` / the chip send
// the WEB APP's link. Pinned: the link by value (the SAME key + builder as TASK-530's admin cell, `openExternalBrowser=1`) · the reply
// in both languages (✅ FINAL words since TASK-550 — by value in `approved-copy-task550.test.ts`; the FORM kept here) · the key unset ⇒ a sentence, never a broken link · no subscribe link, no token minted ·
// the subscribe PAGE and the `.ics` FEED still answer (not advertised ≠ removed) · the approved help list untouched until the owner rules.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../db";
import { fakeDispatchBoundary } from "../test-support/line-dispatch-fakes";
import { handleLineWebhookEvents } from "./line-webhook.service";
import * as calendarSvc from "./calendar.service";
import * as lineClient from "../lib/line-client";
import { t, tb } from "../lib/line-i18n";
import { ADMIN_URL_ENV } from "../lib/line-rich-menu";
import { webAppLink } from "../lib/web-app-link";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const root = resolve(import.meta.dir, "..", "..");
const BASE = "https://app.example.test";
const LINK = `${BASE}/?openExternalBrowser=1`;
const U = "Uteacher0536";
const TOKEN = "Tk0_abcdefGHIJKLmnopQRSTuvwx-53653653"; // token-SHAPED, built here — no real token
const spies: Array<{ mockRestore: () => void }> = [];
const saved = process.env[ADMIN_URL_ENV];
beforeEach(() => { process.env[ADMIN_URL_ENV] = BASE; });
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  if (saved === undefined) delete process.env[ADMIN_URL_ENV]; else process.env[ADMIN_URL_ENV] = saved;
});

/** A linked teacher asks for their calendar — by the chip (postback) or by typing — through the REAL dispatcher. */
async function ask(how: { tap: true } | { type: string }, lang: "TH" | "EN" = "TH") {
  const replies: any[] = [];
  let minted = 0;
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => undefined) as any));
  fakeDispatchBoundary(spies);
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => ({ id: "t1", lineUserId: U, nickname: "KK", name: "Kanokwan K.", lineLang: lang })) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(calendarSvc, "getCalendarTokenForLineUser").mockImplementation((async () => { minted++; return TOKEN; }) as any));
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { replies.push(...m); }) as any));
  const ev = "tap" in how
    ? { type: "postback", replyToken: "rt", source: { userId: U }, postback: { data: "action=calendar" } }
    : { type: "message", replyToken: "rt", source: { userId: U }, message: { type: "text", text: how.type } };
  await handleLineWebhookEvents([ev as any]);
  return { text: replies.map((m) => m.text).join("\n"), minted };
}

describe("🔑 the reply sends the WEB APP — the link by value, in both languages", () => {
  for (const how of [{ tap: true } as const, { type: "ปฏิทิน" }, { type: "calendar" }]) {
    test(`${"tap" in how ? "the chip (action=calendar)" : `typed "${how.type}"`} ⇒ ONE link, the web app + openExternalBrowser=1, alone on its line; nothing minted`, async () => {
      const r = await ask(how);
      const links = r.text.match(/\bhttps?:\/\/\S+/g) ?? [];
      expect(links.length).toBe(2); // bilingual (`tb`): the one link once per language
      expect([...new Set(links)]).toEqual([LINK]);
      for (const line of r.text.split("\n").filter((l) => l.includes(BASE))) expect(line).toBe(LINK); // alone: nothing for a linkifier to swallow
      expect(r.text).not.toMatch(/webcal|calendar\/subscribe|\.ics/);
      expect(r.minted).toBe(0); // asking no longer mints a calendar token
    });
  }
  test("the words' FORM (both languages) — kept beside TASK-550's by-value pin: the calendar mark, the app's name, the link, then the LOGIN — with an account from the admin", () => {
    for (const lang of ["TH", "EN"] as const) {
      const lines = t("cal_web_link", lang, { url: LINK }).split("\n");
      expect(lines[0]).toMatch(/^📅 .*SOM SCHEDULE:$/);
      expect(lines[1]).toBe(LINK);
      expect(lines[2]).toBe("");
      expect(lines[3]).toMatch(lang === "TH" ? /เข้าสู่ระบบ.*แอดมิน/ : /log in.*admin/);
    }
    for (const lang of ["TH", "EN"] as const) expect(tb("cal_web_link", { url: LINK })).toContain(t("cal_web_link", lang, { url: LINK })); // bilingual (`tb`), both halves whole
  });
});

describe("🔑 ONE address, ONE rule — the admin cell's key and builder, reused", () => {
  test("`webAppLink` is TASK-530's builder over TASK-530's key: https, trailing slash tidied, openExternalBrowser; a bad base ⇒ null", () => {
    expect(ADMIN_URL_ENV).toBe("PUBLIC_ADMIN_BASE_URL");
    expect(webAppLink(`${BASE}/`)).toBe(LINK);
    for (const bad of ["", "   ", "http://app.example.test", `${BASE}/?x=1`]) expect(webAppLink(bad)).toBeNull(); // (no argument ⇒ the env key — the unset case is below)
  });
  test("no SECOND key for the same address: the `PUBLIC_*` env names read anywhere in src are exactly the three known ones", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : []; });
    const names = new Set<string>();
    for (const f of walk(resolve(root, "src"))) for (const m of readFileSync(f, "utf8").matchAll(/process\.env\.(PUBLIC_[A-Z0-9_]+)|"(PUBLIC_[A-Z0-9_]+)"/g)) names.add((m[1] ?? m[2])!);
    expect([...names].sort()).toEqual(["PUBLIC_ADMIN_BASE_URL", "PUBLIC_CALENDAR_BASE_URL", "PUBLIC_CHECKIN_BASE_URL"]);
  });
  test("the key unset ⇒ the generic sentence and a LOUD log — never a broken link, never the old subscribe link", async () => {
    delete process.env[ADMIN_URL_ENV];
    const logs: string[] = [];
    spies.push(spyOn(console, "error").mockImplementation(((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }) as any));
    const r = await ask({ tap: true });
    expect(r.text).toContain(t("generic_error", "TH"));
    expect(r.text).not.toMatch(/https?:\/\/|webcal/);
    expect(r.minted).toBe(0);
    expect(logs.join("\n")).toContain("🔴 [TASK-536] PUBLIC_ADMIN_BASE_URL is unset or invalid");
  });
});

describe("🚫 not advertised ≠ removed — the subscribe PAGE and the `.ics` FEED still answer, for anyone already subscribed", () => {
  test("GET /api/calendar/subscribe/<token> ⇒ 200 HTML (the page, unchanged)", async () => {
    spies.push(spyOn(calendarSvc, "calendarTokenExists").mockImplementation((async () => true) as any));
    const r = await rootApp.fetch(new Request(`http://localhost/api/calendar/subscribe/${TOKEN}`));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
  });
  test("GET /api/calendar/<token>.ics ⇒ 200 text/calendar (the feed, unchanged)", async () => {
    spies.push(spyOn(calendarSvc, "findBookingsForCalendarToken").mockImplementation((async () => ({ teacher: { nickname: "KK", lineLang: "TH" }, rows: [] })) as any));
    const r = await rootApp.fetch(new Request(`http://localhost/api/calendar/${TOKEN}.ics`));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/calendar");
    expect(await r.text()).toContain("BEGIN:VCALENDAR");
  });
  test("both routes are still MOUNTED before the auth guard (by source) — nobody deleted them while removing the advert", () => {
    const CAL = readFileSync(resolve(root, "src/routes/calendar.ts"), "utf8");
    expect(CAL).toContain('.get("/calendar/subscribe/:token", async (c) => {');
    expect(CAL).toContain('.get("/calendar/:file", async (c) => {');
    const IDX = readFileSync(resolve(root, "src/index.ts"), "utf8");
    expect(IDX.indexOf('app.route("/api", publicCalendar);')).toBeLessThan(IDX.indexOf('app.use("/api/*", authMiddleware);'));
  });
});

describe("🚫 what must not move", () => {
  test("the APPROVED help list — 🔻 TASK-548: the owner ruled; the calendar line is the NEW approved one, by value", () => {
    expect(t("teacher_menu_body", "TH")).toBe("คำสั่งที่ใช้ได้:\n· ตารางของฉัน — ตารางสอนวันนี้ / สัปดาห์นี้\n· ปฏิทิน — ลิงก์เข้าเว็บ ดูตารางสอนบนมือถือ");
    expect(t("teacher_menu_body", "EN")).toBe("Available Commands:\n· My Schedule — Today's / This week's schedule\n· Calendar — Link to the web app: your schedule on your phone");
  });
  test("the chip keeps its label and its action; `ตารางของฉัน` still goes to the schedule (not the web link)", async () => {
    expect([t("btn_calendar", "TH"), t("btn_calendar", "EN")]).toEqual(["ปฏิทินของฉัน", "My calendar"]);
    const W = readFileSync(resolve(root, "src/services/line-webhook.service.ts"), "utf8");
    expect(W).toContain('chip("btn_calendar", "action=calendar")');
    expect(W).toContain('if (action === "calendar") return doTeacherCalendar(lineUserId, replyToken, lang);');
  });
});
