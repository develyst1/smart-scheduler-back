import { describe, expect, test } from "bun:test";
import { dayHeading, renderSchedule, type SchedRow } from "./line-schedule";

const row = (o: Partial<SchedRow> = {}): SchedRow => ({
  date: "2026-07-30", // a Thursday
  startTime: "09:00:00",
  studentName: "น้องเอ",
  subjectName: "Surfskate",
  status: "CONFIRMED",
  ...o,
});

// REQ-067 Part B (TASK-175): the old renderer put a whole session on ONE line, which wrapped mid-word on a
// phone. These tests are about the SHAPE — what a teacher's thumb has to scroll past — not just the content.
describe("renderSchedule (REQ-016 / TASK-043 · reshaped by REQ-067 Part B)", () => {
  test("today: time leads, no date heading, translated status (TH)", () => {
    const out = renderSchedule([row()], "TH", "today");
    expect(out).toContain("🗓️ ตารางวันนี้");
    expect(out).toContain("09:00  น้องเอ");
    expect(out).toContain("Surfskate · ยืนยันแล้ว");
    expect(out).not.toContain("2026-07-30"); // today view never repeats today's date
    expect(out).not.toContain("▸"); // …nor a day heading for the only day there is
  });

  test("week: the day is named ONCE as a heading, then its sessions", () => {
    const out = renderSchedule(
      [row({ startTime: "09:00:00" }), row({ startTime: "11:00:00", studentName: "น้องบี" })],
      "TH",
      "week",
    );
    expect(out).toContain("▸ พฤหัสบดี 30/07");
    expect(out.match(/▸/g)).toHaveLength(1); // one heading for two sessions on the same day
    expect(out).toContain("09:00  น้องเอ");
    expect(out).toContain("11:00  น้องบี");
  });

  test("🔴 a session never occupies one long line — time+student, then program·status beneath", () => {
    // This is the whole point: no line carries all four fields, so nothing wraps mid-word on a phone.
    const out = renderSchedule([row({ subjectName: "Bike / Scooter / Balance Cruiser" })], "EN", "week");
    const lines = out.split("\n");
    expect(lines.some((l) => l.includes("09:00") && l.includes("น้องเอ") && !l.includes("Bike"))).toBe(true);
    expect(lines.some((l) => l.trim().startsWith("Bike") && l.includes("Confirmed"))).toBe(true);
  });

  test("days are separated, and each day heads its own block", () => {
    const out = renderSchedule([row({ date: "2026-08-01" }), row({ date: "2026-07-30" })], "EN", "week");
    expect(out).toContain("▸ Thursday 30/07");
    expect(out).toContain("▸ Saturday 01/08");
    expect(out).toContain("\n\n▸ Saturday"); // a blank line between days
  });

  test("🔑 sorted by day then time regardless of query order — it is a plan, not a list", () => {
    const out = renderSchedule(
      [
        row({ date: "2026-08-01", startTime: "10:00:00", studentName: "later-day" }),
        row({ date: "2026-07-30", startTime: "15:00:00", studentName: "afternoon" }),
        row({ date: "2026-07-30", startTime: "09:00:00", studentName: "morning" }),
      ],
      "EN",
      "week",
    );
    expect(out.indexOf("morning")).toBeLessThan(out.indexOf("afternoon"));
    expect(out.indexOf("afternoon")).toBeLessThan(out.indexOf("later-day"));
  });

  test("clear empty state, both languages (regression)", () => {
    expect(renderSchedule([], "TH", "today")).toContain("ไม่มีคาบสอนในช่วงนี้");
    expect(renderSchedule([], "EN", "week")).toContain("No classes in this range");
  });

  test("caps a long list and reports the overflow — the LINE size guard (regression)", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ startTime: `${String(9 + (i % 9)).padStart(2, "0")}:00:00` }));
    const out = renderSchedule(rows, "EN", "week", 20);
    expect(out.split("\n").filter((l) => /^\d{2}:\d{2} /.test(l))).toHaveLength(20);
    expect(out).toContain("and 5 more");
  });

  test("bilingual day names (AC-7)", () => {
    expect(dayHeading("2026-08-02", "TH")).toBe("อาทิตย์ 02/08"); // Sunday — their busiest day
    expect(dayHeading("2026-08-02", "EN")).toBe("Sunday 02/08");
  });
});

// SPEC-063 / TASK-178 (REQ-068) — the note reaches the teacher who needs it.
describe("attendee note in the teacher's schedule (TASK-178)", () => {
  test("a note appears indented under its own session", () => {
    const out = renderSchedule([row({ attendeeNote: "พาน้องมาด้วย 2 คน" })], "TH", "week");
    const lines = out.split("\n");
    const i = lines.findIndex((l) => l.includes("พาน้องมาด้วย"));
    expect(i).toBeGreaterThan(-1);
    expect(lines[i]!.startsWith("   ")).toBe(true); // part of the session, not another schedule line
    expect(lines[i - 1]).toContain("Surfskate"); // directly under the session it belongs to
  });

  test("🔴 AC-5: a session with no note is byte-identical to before the feature", () => {
    // Almost every session has no note; a "note: —" placeholder on all of them would cost more attention than
    // the feature is worth.
    const without = renderSchedule([row()], "TH", "week");
    expect(renderSchedule([row({ attendeeNote: null })], "TH", "week")).toBe(without);
    expect(renderSchedule([row({ attendeeNote: "   " })], "TH", "week")).toBe(without); // blanks are not notes
  });

  test("the right note lands on the right session when several days carry one", () => {
    const out = renderSchedule(
      [
        row({ date: "2026-07-30", studentName: "เอ", attendeeNote: "แพ้ถั่ว" }),
        row({ date: "2026-08-01", studentName: "บี", attendeeNote: "มาสาย 10 นาที" }),
      ],
      "EN",
      "week",
    );
    expect(out.indexOf("แพ้ถั่ว")).toBeLessThan(out.indexOf("บี"));
    expect(out.indexOf("บี")).toBeLessThan(out.indexOf("มาสาย 10 นาที"));
  });

  test("today's view carries the note too — the teacher reads that one on the day", () => {
    expect(renderSchedule([row({ attendeeNote: "แพ้ถั่ว" })], "TH", "today")).toContain("แพ้ถั่ว");
  });
});
