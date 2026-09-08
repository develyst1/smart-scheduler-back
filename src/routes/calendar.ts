import { Hono } from "hono";
import { buildCalendar } from "../lib/ics";
import { tokenFromIcsFilename } from "../lib/calendar-link";
import { findBookingsForCalendarToken } from "../services/calendar.service";

/**
 * Public per-teacher calendar feed (REQ-017 / TASK-044) — no JWT; the token in the URL IS the credential,
 * exactly like `publicCheckin`. Mounted BEFORE `authMiddleware` in index.ts.
 *
 * Unknown or rotated token → 404 (never reveal whether it merely expired). The token is never logged, and the
 * response is `private, no-store` so it isn't cached by proxies.
 */
export const publicCalendar = new Hono().get("/calendar/:file", async (c) => {
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
      studentName: b.student?.name ?? null,
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
