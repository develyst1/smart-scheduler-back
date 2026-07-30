import { describe, expect, test } from "bun:test";
import { buildCalendar, escapeIcsText, foldIcsLine, icsUid, toIcsUtc } from "./ics";

const NOW = new Date("2026-07-31T03:00:00.000Z");
const booking = (o: Partial<Parameters<typeof buildCalendar>[0][number]> = {}) => ({
  id: "b1",
  date: "2026-07-31",
  startTime: "09:00:00",
  endTime: "10:00:00",
  studentName: "น้องเอ",
  subjectName: "Surfskate",
  status: "CONFIRMED",
  updatedAt: new Date("2026-07-30T12:00:00.000Z"),
  ...o,
});

describe("toIcsUtc — Bangkok wall-clock → UTC, never floating (TASK-044)", () => {
  test("09:00 Bangkok is 02:00Z the same day", () => {
    expect(toIcsUtc("2026-07-31", "09:00:00")).toBe("20260731T020000Z");
  });
  test("accepts HH:MM as well as HH:MM:SS", () => {
    expect(toIcsUtc("2026-07-31", "09:00")).toBe("20260731T020000Z");
  });
  test("an early slot rolls back to the previous UTC day (the off-by-one trap)", () => {
    expect(toIcsUtc("2026-07-31", "05:00:00")).toBe("20260730T220000Z");
  });
});

describe("escapeIcsText — RFC 5545 TEXT escaping", () => {
  test("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeIcsText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
    expect(escapeIcsText("line1\nline2")).toBe("line1\\nline2");
  });
});

describe("foldIcsLine — ≤75 OCTETS, counted in UTF-8 (Thai is 3 bytes/char)", () => {
  test("a short line is untouched", () => {
    expect(foldIcsLine("SUMMARY:hi")).toBe("SUMMARY:hi");
  });
  test("a long ASCII line folds with a leading-space continuation", () => {
    const folded = foldIcsLine(`SUMMARY:${"x".repeat(200)}`);
    expect(folded).toContain("\r\n ");
    for (const l of folded.split("\r\n")) {
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    }
  });
  test("🔑 a long THAI line folds by bytes and never splits a character", () => {
    const folded = foldIcsLine(`SUMMARY:${"ก".repeat(100)}`);
    for (const l of folded.split("\r\n")) {
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    }
    // every Thai char survives the fold (no mojibake from a split code point)
    expect(folded.replace(/\r\n /g, "").endsWith("ก".repeat(100))).toBe(true);
  });
});

describe("buildCalendar — the feed document", () => {
  test("well-formed VCALENDAR, CRLF-terminated, Bangkok-labelled", () => {
    const ics = buildCalendar([booking()], { now: NOW });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("X-WR-TIMEZONE:Asia/Bangkok");
  });

  test("🔑 UID is stable per booking id → an edit UPDATES, never duplicates", () => {
    const a = buildCalendar([booking({ studentName: "น้องเอ" })], { now: NOW });
    const b = buildCalendar([booking({ studentName: "น้องบี" })], { now: NOW }); // same id, edited
    expect(a).toContain(`UID:${icsUid("b1")}`);
    expect(b).toContain(`UID:${icsUid("b1")}`);
  });

  test("🔑 a CANCELLED booking is INCLUDED with STATUS:CANCELLED so subscribers remove it", () => {
    const ics = buildCalendar([booking({ status: "CANCELLED" })], { now: NOW });
    expect(ics).toContain(`UID:${icsUid("b1")}`);
    expect(ics).toContain("STATUS:CANCELLED");
  });

  test("PENDING maps to TENTATIVE; other statuses to CONFIRMED", () => {
    expect(buildCalendar([booking({ status: "PENDING" })], { now: NOW })).toContain("STATUS:TENTATIVE");
    expect(buildCalendar([booking({ status: "SICK_LEAVE" })], { now: NOW })).toContain("STATUS:CONFIRMED");
  });

  test("SEQUENCE advances when the booking is updated later", () => {
    const older = buildCalendar([booking({ updatedAt: new Date("2026-07-30T12:00:00Z") })], { now: NOW });
    const newer = buildCalendar([booking({ updatedAt: new Date("2026-07-30T13:00:00Z") })], { now: NOW });
    const seq = (s: string) => Number(s.match(/SEQUENCE:(\d+)/)![1]);
    expect(seq(newer)).toBeGreaterThan(seq(older));
  });

  test("times are UTC stamps and the summary carries student + subject", () => {
    const ics = buildCalendar([booking()], { now: NOW });
    expect(ics).toContain("DTSTART:20260731T020000Z");
    expect(ics).toContain("DTEND:20260731T030000Z");
    expect(ics.replace(/\r\n /g, "")).toContain("SUMMARY:น้องเอ · Surfskate");
  });

  test("an empty feed is still a valid calendar", () => {
    const ics = buildCalendar([], { now: NOW });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});
