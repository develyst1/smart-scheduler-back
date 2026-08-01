// Route-level dispatch test for the public feed (TASK-044): an unknown/rotated token must 404, and a valid one
// must return `text/calendar` — verified without a DB by stubbing the service (the DB query itself is OA smoke).
import { afterAll, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here

// TASK-072: narrow spies instead of a whole-module `mock.module` — that replaced the module PROCESS-WIDE and
// leaked into every other test file. Only `findBookingsForCalendarToken` is reached by these requests.
const cal = await import("../services/calendar.service");
const { publicCalendar } = await import("./calendar");

const spy = spyOn(cal, "findBookingsForCalendarToken").mockImplementation((async (token: string) =>
  token === "goodtoken123"
    ? {
        teacher: { nickname: "ครูเอ" },
        rows: [
          {
            id: "b1",
            date: "2026-07-31",
            startTime: "09:00:00",
            endTime: "10:00:00",
            student: { name: "น้องเอ" },
            subject: { name: "Surfskate" },
            status: "CONFIRMED",
            updatedAt: new Date("2026-07-30T12:00:00Z"),
          },
        ],
      }
    : null) as any); // unknown OR rotated → indistinguishable, both 404
afterAll(() => spy.mockRestore());

describe("GET /calendar/:token.ics (TASK-044)", () => {
  test("a valid token returns a text/calendar feed containing the teacher's booking", async () => {
    const res = await publicCalendar.request("/calendar/goodtoken123.ics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("UID:booking-b1@smart-scheduler");
    expect(body).toContain("DTSTART:20260731T020000Z");
  });

  test("🔐 an unknown / rotated token 404s (no hint which)", async () => {
    expect((await publicCalendar.request("/calendar/badtoken12345.ics")).status).toBe(404);
  });

  test("a non-.ics path 404s", async () => {
    expect((await publicCalendar.request("/calendar/goodtoken123")).status).toBe(404);
  });
});
