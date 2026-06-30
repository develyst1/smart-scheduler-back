import { describe, expect, test } from "bun:test";
import { isWithinCheckinWindow, CHECKIN_EARLY_MINUTES } from "./checkin";

describe("checkin window (C.1)", () => {
  test("inside window on booking day", () => {
    expect(
      isWithinCheckinWindow("2026-06-30", "10:00", "11:00", {
        date: "2026-06-30",
        time: "09:45",
        minutes: 9 * 60 + 45,
      }),
    ).toBe(true);
  });

  test("too early", () => {
    expect(
      isWithinCheckinWindow("2026-06-30", "10:00", "11:00", {
        date: "2026-06-30",
        time: "08:00",
        minutes: 8 * 60,
      }),
    ).toBe(false);
  });

  test("wrong day", () => {
    expect(
      isWithinCheckinWindow("2026-06-30", "10:00", "11:00", {
        date: "2026-07-01",
        time: "10:00",
        minutes: 10 * 60,
      }),
    ).toBe(false);
  });

  test("early open is 30 min before start", () => {
    expect(CHECKIN_EARLY_MINUTES).toBe(30);
  });
});
