// 🔻 TASK-736 (P26) — the camp FAMILY reminder prints the REAL hours. The hours are FIXED per half (the CEO, 2026-10-12): morning 10:00-12:00 · afternoon 13:00-15:00 · all day 10:00-15:00,
// with a COLON (the set-1 house rule; Khwan wrote a dot). The layout is her P26 cell, copied BY MACHINE from the COPY-SET (dots → colons, nothing else).
import { describe, expect, test } from "bun:test";
import { formatOutboxMessage } from "./line-message";
import { CAMP_HALF_HOURS, campHoursOf } from "./camp-hours";

const row = (half: string) => ({ child: "Student A", weekName: "Week 1", date: "2026-10-15", half });
const render = (rows: any[], lang: "TH" | "EN") => formatOutboxMessage({ kind: "camp_reminder", audience: "parent", rows } as any, {}, lang, "parent");
const FULL_DAY = "⏱️TODAY'S SCHEDULE:\n\nStudent : Student A\nCamp : Week 1\nDate : 15-10-2026\nTime : 10:00-15:00"; // her TH = EN cell (dot → colon)
const MORNING = "⏱️TODAY'S SCHEDULE:\n\nStudent : Student A\nCamp : Week 1\nDate : 15-10-2026\nTime : 10:00-12:00"; // her EN cell (dot → colon)

describe("🔴 TASK-736 — P26: her layout with the real hours (a colon)", () => {
  test("ALL DAY — her sample; one text for both languages", () => {
    expect(render([row("FULL")], "TH")).toBe(FULL_DAY);
    expect(render([row("FULL")], "EN")).toBe(FULL_DAY);
  });
  test("MORNING — her EN sample", () => {
    expect(render([row("AM")], "EN")).toBe(MORNING);
    expect(render([row("AM")], "TH")).toBe(MORNING);
  });
  test("AFTERNOON — 13:00-15:00 (the CEO's hours), same layout", () => {
    const text = MORNING.replace("10:00-12:00", "13:00-15:00");
    expect(render([row("PM")], "EN")).toBe(text);
    expect(render([row("PM")], "TH")).toBe(text);
  });
  test("🚫 the old words are gone (Morning (AM) / ช่วง / ช่วงเช้า) and no DOT time ever prints", () => {
    for (const half of ["AM", "PM", "FULL"]) {
      for (const lang of ["TH", "EN"] as const) {
        const out = render([row(half)], lang);
        expect(out).not.toMatch(/Morning|Afternoon|Full day|ช่วง|เต็มวัน|\d{2}\.\d{2}/);
        expect(out.split("\n").at(-1)).toMatch(/^Time : \d{2}:\d{2}-\d{2}:\d{2}$/);
      }
    }
  });
  test("several children: one block each, each with its OWN half's hours", () => {
    const blocks = render([row("AM"), row("PM")], "EN").split("\n\n");
    expect(blocks.slice(1).map((b) => b.split("\n").at(-1))).toEqual(["Time : 10:00-12:00", "Time : 13:00-15:00"]);
  });
  test("an unknown half ⇒ no Time line (never a guessed hour)", () => {
    expect(render([row("???")], "EN").split("\n").at(-1)).toBe("Date : 15-10-2026");
  });
});

describe("🔴 TASK-736 — the ONE map (shared with TASK-735)", () => {
  test("the fixed hours, a colon; anything else is undefined", () => {
    expect(CAMP_HALF_HOURS).toEqual({ AM: "10:00-12:00", PM: "13:00-15:00", FULL: "10:00-15:00" });
    expect([campHoursOf("AM"), campHoursOf("PM"), campHoursOf("FULL")]).toEqual(["10:00-12:00", "13:00-15:00", "10:00-15:00"]);
    for (const bad of [undefined, null, "", "am", "toString", "constructor"]) expect(campHoursOf(bad as any)).toBeUndefined();
  });
});
