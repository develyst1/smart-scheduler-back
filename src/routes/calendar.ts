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
  const token = tokenFromIcsFilename(c.req.param("file"));
  if (!token) return c.notFound();

  const found = await findBookingsForCalendarToken(token);
  if (!found) return c.notFound();

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
    { calendarName: `ตารางสอน ${found.teacher.nickname}` },
  );

  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header("Cache-Control", "private, no-store");
  return c.body(ics);
});
