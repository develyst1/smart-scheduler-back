import { describe, expect, test } from "bun:test";
import { renderSchedule, type SchedRow } from "./line-schedule";

const row = (o: Partial<SchedRow> = {}): SchedRow => ({
  date: "2026-07-30",
  startTime: "09:00:00",
  studentName: "น้องเอ",
  subjectName: "Surfskate",
  status: "CONFIRMED",
  ...o,
});

describe("renderSchedule (REQ-016 / TASK-043)", () => {
  test("today: time only + translated status (TH)", () => {
    const out = renderSchedule([row()], "TH", "today");
    expect(out).toContain("🗓️ ตารางวันนี้");
    expect(out).toContain("09:00 · น้องเอ · Surfskate · ยืนยันแล้ว");
    expect(out).not.toContain("2026-07-30"); // today view omits the date
  });

  test("week: date-prefixed rows + EN status label", () => {
    const out = renderSchedule([row({ status: "SICK_LEAVE" })], "EN", "week");
    expect(out).toContain("🗓️ This week's schedule");
    expect(out).toContain("2026-07-30 09:00 · น้องเอ · Surfskate · Leave");
  });

  test("clear empty state, both languages", () => {
    expect(renderSchedule([], "TH", "today")).toContain("ไม่มีคาบสอนในช่วงนี้");
    expect(renderSchedule([], "EN", "week")).toContain("No classes in this range");
  });

  test("caps a long list and reports the overflow (LINE size guard)", () => {
    const rows = Array.from({ length: 25 }, () => row());
    const out = renderSchedule(rows, "EN", "week", 20);
    expect(out.split("\n").filter((l) => l.includes(" · ")).length).toBe(20);
    expect(out).toContain("and 5 more");
  });
});
