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

  // SPEC-029 / TASK-101: the early-window is a param (the check-in service passes the resolved setting). A wider
  // window opens check-in earlier with no deploy — the AC the settings mechanism exists to satisfy.
  test("earlyMinutes param widens/narrows the window", () => {
    const at0830 = { date: "2026-06-30", time: "08:30", minutes: 8 * 60 + 30 };
    // 08:30 is 90 min before a 10:00 class → closed at default 30, open once the setting is raised to 90.
    expect(isWithinCheckinWindow("2026-06-30", "10:00", "11:00", at0830)).toBe(false);
    expect(isWithinCheckinWindow("2026-06-30", "10:00", "11:00", at0830, 90)).toBe(true);
    // Narrowing to 0 closes the pre-start grace: 09:45 is inside the default 30 but outside a 0-minute window.
    const at0945 = { date: "2026-06-30", time: "09:45", minutes: 9 * 60 + 45 };
    expect(isWithinCheckinWindow("2026-06-30", "10:00", "11:00", at0945, 0)).toBe(false);
  });
});
