// UC-029 + SPEC-048 / TASK-146 (REQ-047). The cut-off is now a SETTING, not a constant, so these tests pin the
// comparator + the boundary + the key mapping; the numbers themselves live in `lib/settings.ts` and are
// asserted there.
import { describe, expect, test } from "bun:test";
import {
  hasEnoughLeaveNotice,
  leaveCutoffKey,
  leaveNoticeMessage,
  minutesUntilClass,
} from "./leave-notice";

const now = { date: "2026-07-15", time: "10:00", minutes: 600 }; // 10:00

describe("leave advance-notice rules", () => {
  test("which setting governs which teacher — PART_TIME shares the full-time rule (REQ-047)", () => {
    expect(leaveCutoffKey("FULL_TIME")).toBe("leave_cutoff_hours_fulltime");
    expect(leaveCutoffKey("PART_TIME")).toBe("leave_cutoff_hours_fulltime");
    expect(leaveCutoffKey("FREELANCE")).toBe("leave_cutoff_hours_freelance");
  });

  test("minutesUntilClass — same day", () => {
    expect(minutesUntilClass("2026-07-15", "12:00", now)).toBe(120);
    expect(minutesUntilClass("2026-07-15", "10:00", now)).toBe(0);
  });

  test("minutesUntilClass — spans days", () => {
    expect(minutesUntilClass("2026-07-16", "10:00", now)).toBe(1440);
    expect(minutesUntilClass("2026-07-14", "10:00", now)).toBe(-1440);
  });

  test("AC-1/2/3 at the default 3h: less is refused, more is allowed, EXACTLY 3h is allowed", () => {
    expect(hasEnoughLeaveNotice("2026-07-15", "12:59", 3, now)).toBe(false); // 2h59
    expect(hasEnoughLeaveNotice("2026-07-15", "13:00", 3, now)).toBe(true); // exactly 3h — the boundary
    expect(hasEnoughLeaveNotice("2026-07-15", "14:00", 3, now)).toBe(true);
  });

  test("AC-4: a different configured cut-off changes the answer immediately, same inputs", () => {
    expect(hasEnoughLeaveNotice("2026-07-15", "12:00", 1, now)).toBe(true); // 2h ahead, cut-off 1h
    expect(hasEnoughLeaveNotice("2026-07-15", "12:00", 6, now)).toBe(false); // same booking, cut-off 6h
  });

  test("a 0-hour cut-off still refuses a class that has already started", () => {
    expect(hasEnoughLeaveNotice("2026-07-15", "10:00", 0, now)).toBe(true); // starting exactly now
    expect(hasEnoughLeaveNotice("2026-07-15", "09:00", 0, now)).toBe(false); // already started
  });

  test("class already started / past → never enough notice", () => {
    expect(hasEnoughLeaveNotice("2026-07-15", "09:00", 3, now)).toBe(false);
  });

  test("AC-7: the refusal names the configured hours AND the session time, TH + EN", () => {
    expect(leaveNoticeMessage(3, "13:00:00", "TH")).toBe(
      "ขออภัยค่ะ ลาได้ล่วงหน้าอย่างน้อย 3 ชั่วโมงก่อนเริ่มคาบ คาบนี้เริ่ม 13:00 น. หากจำเป็น กรุณาติดต่อแอดมิน",
    );
    expect(leaveNoticeMessage(6, "09:00", "EN")).toBe(
      "Sorry — leave must be at least 6 hours before the session. This one starts at 09:00. Please contact the admin if you need help.",
    );
    expect(leaveNoticeMessage(3, "13:00:00")).toContain("3 ชั่วโมง"); // default TH
  });
});
