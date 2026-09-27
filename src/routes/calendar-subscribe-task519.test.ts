// TASK-519 — the coach's calendar link no longer hands the token to a stranger's site.
// 🔑 Proven against the REAL rendered message text (the bug was that what we send and what LINE shows are different things), and
// the landing page by value: its headers, its allow-list (two URLs, fixed words — nothing about the coach), its 404.
// 📌 What LINE's app does with the text, and what an in-app browser does with a `webcal://` tap, cannot run here: @Tanya confirms
// on a device. This file pins everything that IS ours.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../db";
import { fakeDispatchBoundary } from "../test-support/line-dispatch-fakes";
import { handleLineWebhookEvents } from "../services/line-webhook.service";
import * as calendarSvc from "../services/calendar.service";
import * as lineClient from "../lib/line-client";
import { calendarPageUrl, calendarUrls } from "../lib/calendar-link";
import { renderCalendarSubscribePage } from "../lib/calendar-subscribe-page";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };

const HOST = "https://som.develyst.online";
const TOKEN = "Tk0_abcdefGHIJKLmnopQRSTuvwx-12345678"; // a token-SHAPED test value (base64url), built here — no real token
const U = "Uteacher0519";
const spies: Array<{ mockRestore: () => void }> = [];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = { a: process.env.PUBLIC_CALENDAR_BASE_URL, b: process.env.PUBLIC_CHECKIN_BASE_URL };
  delete process.env.PUBLIC_CALENDAR_BASE_URL;
  process.env.PUBLIC_CHECKIN_BASE_URL = HOST;
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  if (saved.a === undefined) delete process.env.PUBLIC_CALENDAR_BASE_URL; else process.env.PUBLIC_CALENDAR_BASE_URL = saved.a;
  if (saved.b === undefined) delete process.env.PUBLIC_CHECKIN_BASE_URL; else process.env.PUBLIC_CHECKIN_BASE_URL = saved.b;
});

/** A linked teacher taps "My calendar" — the REAL dispatcher; the token lookup and the LINE send are the only fakes that matter. */
async function tapMyCalendar(lang: "TH" | "EN") {
  const replies: any[] = [];
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => undefined) as any));
  fakeDispatchBoundary(spies);
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => ({ id: "t1", lineUserId: U, nickname: "KK", name: "Kanokwan K.", lineLang: lang })) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db, "insert").mockImplementation((() => ({ values: () => ({ onConflictDoUpdate: async () => {}, onConflictDoNothing: async () => {} }) })) as any));
  spies.push(spyOn(calendarSvc, "getCalendarTokenForLineUser").mockImplementation((async () => TOKEN) as any));
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { replies.push(...m); }) as any));
  await handleLineWebhookEvents([{ type: "postback", replyToken: "rt", source: { userId: U }, postback: { data: "action=calendar" } } as any]);
  return replies;
}

describe("🔴 TASK-519 — the LINE reply: an https link to OUR landing page, never webcal://", () => {
  for (const lang of ["TH", "EN"] as const) {
    test(`${lang}: the REAL rendered text carries ONE link — https, our host, the token in the PATH — alone on its line; no webcal anywhere`, async () => {
      const [msg] = await tapMyCalendar(lang);
      const text: string = msg.text;
      expect(text).not.toContain("webcal");
      const links = text.match(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi) ?? [];
      expect(links.length).toBeGreaterThan(0); // the reply is bilingual (`tb`), so the one link appears once per language
      expect([...new Set(links)]).toEqual([`${HOST}/api/calendar/subscribe/${TOKEN}`]);
      for (const line of text.split("\n").filter((l) => l.includes(TOKEN))) {
        expect(line).toBe(`${HOST}/api/calendar/subscribe/${TOKEN}`); // alone on its line: nothing beside it for a linkifier to swallow
      }
      expect(links.every((l) => !l.includes("?"))).toBe(true); // the credential never rides a query string
      expect(new URL(links[0]!).host).toBe("som.develyst.online"); // the box's own check-in host, from its env — no host change
    });
  }
  test("the page URL is derived from the SAME base as the feed (one host decision): same origin, `/subscribe/<token>` in place of `<token>.ics`", () => {
    const { https } = calendarUrls(TOKEN);
    expect(new URL(calendarPageUrl(TOKEN)).origin).toBe(new URL(https).origin);
    expect(calendarPageUrl(TOKEN)).toBe(`${HOST}/api/calendar/subscribe/${TOKEN}`);
  });
});

const getPage = (token: string) => rootApp.fetch(new Request(`http://localhost/api/calendar/subscribe/${token}`, { headers: { "x-forwarded-for": "10.51.9.1" } }));

describe("🔴 TASK-519 — the landing page: a subscribe button, the Android URL, and NOTHING about the coach", () => {
  test("🔑 by value: 200 HTML · the button IS the webcal:// feed URL · the https .ics URL to paste · the 'if the button does nothing' line · both languages", async () => {
    spies.push(spyOn(calendarSvc, "calendarTokenExists").mockImplementation((async (t: string) => t === TOKEN) as any));
    const r = await getPage(TOKEN);
    expect(r.status).toBe(200);
    const html = await r.text();
    const { webcal, https } = calendarUrls(TOKEN);
    expect(html).toContain(`<a class="btn" href="${webcal}">`);
    expect(html).toContain(`<code>${https}</code>`);
    expect(html).toContain("ถ้ากดปุ่มแล้วไม่มีอะไรเกิดขึ้น");
    expect(html).toContain("If the button does nothing");
    expect(html).toContain("From URL");
  });

  test("🔑 the headers: no-store · no-referrer · noindex · a CSP that forbids every outside asset", async () => {
    spies.push(spyOn(calendarSvc, "calendarTokenExists").mockImplementation((async () => true) as any));
    const r = await getPage(TOKEN);
    expect({
      type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), referrer: r.headers.get("referrer-policy"),
      robots: r.headers.get("x-robots-tag"), csp: r.headers.get("content-security-policy"),
    }).toEqual({
      type: "text/html; charset=utf-8", cache: "private, no-store", referrer: "no-referrer",
      robots: "noindex, nofollow", csp: "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
  });

  test("🔑 the ALLOW-LIST: the page's only URLs are the two it was handed (our host); no script, no image, no external stylesheet — and no coach identity even when the lookup would have one", async () => {
    // the lookup answers only "exists" — but even a rich teacher row in reach must not reach the page
    spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => ({ id: "t1", nickname: "KK", name: "Kanokwan K.", lineUserId: U })) as any));
    const r = await getPage(TOKEN);
    const html = await r.text();
    const urls = [...new Set(html.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"<]+/gi) ?? [])];
    expect(urls.sort()).toEqual([calendarUrls(TOKEN).https, calendarUrls(TOKEN).webcal].sort());
    expect(html).not.toMatch(/<script|<img|<link |@import|url\(/i);
    for (const who of ["KK", "Kanokwan", U, "t1"]) expect({ who, shown: html.includes(who) }).toEqual({ who, shown: false });
  });

  test("an UNKNOWN (or rotated) token, or one too short to be a token ⇒ the feed's own plain 404 — nothing to tell 'never existed' from 'rotated'", async () => {
    spies.push(spyOn(calendarSvc, "calendarTokenExists").mockImplementation((async () => false) as any));
    for (const t of ["nope-not-a-real-token-000", "short"]) {
      const r = await getPage(t);
      expect({ t, status: r.status, body: await r.text() }).toEqual({ t, status: 404, body: "404 Not Found" });
    }
  });

  test("📌 the renderer's signature IS the allow-list: exactly two strings in — it cannot be handed a coach", () => {
    expect(renderCalendarSubscribePage.length).toBe(1);
    const html = renderCalendarSubscribePage({ webcal: "webcal://h/x.ics", https: "https://h/x.ics" });
    expect(html).toContain('href="webcal://h/x.ics"');
    expect(html).toContain("<code>https://h/x.ics</code>");
    // HTML-escaped: a hostile value cannot break out of the attribute
    expect(renderCalendarSubscribePage({ webcal: 'x" onclick="evil', https: "<b>" })).not.toMatch(/" onclick="|<b>/);
  });
});
