import { afterEach, describe, expect, test } from "bun:test";
import { calendarUrls, tokenFromIcsFilename } from "./calendar-link";

const ORIG = process.env.PUBLIC_CALENDAR_BASE_URL;
afterEach(() => {
  if (ORIG === undefined) delete process.env.PUBLIC_CALENDAR_BASE_URL;
  else process.env.PUBLIC_CALENDAR_BASE_URL = ORIG;
});

describe("calendarUrls (REQ-017 / TASK-044)", () => {
  test("builds the https feed URL and a webcal:// twin (phones offer 'subscribe' for webcal)", () => {
    process.env.PUBLIC_CALENDAR_BASE_URL = "https://som.develyst.online";
    const { https, webcal } = calendarUrls("tok123");
    expect(https).toBe("https://som.develyst.online/api/calendar/tok123.ics");
    expect(webcal).toBe("webcal://som.develyst.online/api/calendar/tok123.ics");
  });

  test("a trailing slash on the base doesn't double up", () => {
    process.env.PUBLIC_CALENDAR_BASE_URL = "https://som.develyst.online/";
    expect(calendarUrls("t").https).toBe("https://som.develyst.online/api/calendar/t.ics");
  });
});

describe("tokenFromIcsFilename — only a real feed request resolves (TASK-044)", () => {
  test("strips the .ics suffix", () => {
    expect(tokenFromIcsFilename("abcdefgh12345.ics")).toBe("abcdefgh12345");
  });
  test("a non-.ics path or a too-short token yields null → the route 404s", () => {
    expect(tokenFromIcsFilename("abcdefgh12345")).toBeNull();
    expect(tokenFromIcsFilename("short.ics")).toBeNull();
    expect(tokenFromIcsFilename(".ics")).toBeNull();
  });
});
