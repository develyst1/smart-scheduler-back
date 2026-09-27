import { Hono } from "hono";
import { buildCalendar } from "../lib/ics";
import { calendarUrls, tokenFromIcsFilename } from "../lib/calendar-link";
import { calendarTokenExists, findBookingsForCalendarToken } from "../services/calendar.service";
import { renderCalendarSubscribePage } from "../lib/calendar-subscribe-page";
import { studentNamesOf } from "../db/mappers";

/**
 * Public per-teacher calendar feed (REQ-017 / TASK-044) — no JWT; the token in the URL IS the credential,
 * exactly like `publicCheckin`. Mounted BEFORE `authMiddleware` in index.ts.
 *
 * Unknown or rotated token → 404 (never reveal whether it merely expired). The token is never logged, and the
 * response is `private, no-store` so it isn't cached by proxies.
 */
export const publicCalendar = new Hono()
/**
 * 🔴 TASK-519 — the coach's calendar LANDING PAGE (a NEW pre-guard public route: the token in the path IS the credential, as for
 * the feed below). The LINE reply links HERE, so a tap reaches our host and the subscribing tap happens in a browser, on a button
 * whose href is the `webcal://` URL (iPhone subscribes as before; Android gets the `https` URL to paste into "From URL").
 * 🔑 By ALLOW-LIST: the page is rendered from the two URLs and fixed words only — no coach name, no class, no count
 * (`renderCalendarSubscribePage` cannot be handed anything else). An unknown token ⇒ the feed's own plain 404.
 * Headers: `no-store` · `no-referrer` (the page must not hand its own URL onward) · `X-Robots-Tag: noindex` (a URL holding a
 * credential must never be crawlable) · a CSP that forbids every script, image, font and stylesheet from anywhere.
 */
.get("/calendar/subscribe/:token", async (c) => {
  const token = c.req.param("token");
  if (token.length < 8 || !(await calendarTokenExists(token))) return c.text("404 Not Found", 404);
  const { https, webcal } = calendarUrls(token);
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return c.body(renderCalendarSubscribePage({ webcal, https }));
})
.get("/calendar/:file", async (c) => {
  // ⚪ TASK-297 — this route KEEPS a plain-text 404, and that is a decision rather than an oversight.
  //
  // The reader is a calendar client (Google, Apple), which reads the STATUS and never our envelope; a JSON
  // body would be noise it has to ignore. 🚫 Changed only because it had to be: `c.notFound()` dispatches
  // to the APP's handler, and TASK-297 gave the app one — so leaving `c.notFound()` here would have silently
  // switched this route to the envelope. **Written out to preserve the behaviour, not to match the others.**
  const plain404 = () => c.text("404 Not Found", 404);

  const token = tokenFromIcsFilename(c.req.param("file"));
  if (!token) return plain404();

  const found = await findBookingsForCalendarToken(token);
  if (!found) return plain404();

  const ics = buildCalendar(
    found.rows.map((b: any) => ({
      id: b.id,
      date: b.date,
      startTime: b.startTime,
      endTime: b.endTime,
      studentName: studentNamesOf(b), // TASK-425 — the ONE name rule's student part
      subjectName: b.subject?.name ?? null,
      status: b.status,
      updatedAt: b.updatedAt ?? null,
    })),
    {
      calendarName: `ตารางสอน ${found.teacher.nickname}`,
      // 🔴 TASK-272 §5 — the DESCRIPTION carries a status LABEL, so it needs the teacher's own language.
      // `findBookingsForCalendarToken` already returns the teacher, so it was in hand here; `null → TH` is
      // the same default every other reply uses.
      lang: found.teacher.lineLang === "EN" ? "EN" : "TH",
    },
  );

  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header("Cache-Control", "private, no-store");
  return c.body(ics);
});
