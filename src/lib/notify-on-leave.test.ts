// TASK-136 (SPEC-044 / REQ-049) — the enum setting the teacher push is gated on, and the two messages the
// event renders into. The enqueue itself is service+DB code (verified by review + Tanya's dev pass with a test
// teacher account); what is unit-testable is that the default keeps the teacher push OFF and that neither
// message can reach a recipient as a raw placeholder.
import { describe, expect, test } from "bun:test";
import { NOTIFY_ON_LEAVE_OPTIONS, SETTINGS, resolveSetting } from "./settings";
import { formatOutboxMessage } from "./line-message";

describe("notify_on_leave setting (AC-1)", () => {
  test("no override → admin_only, so a teacher is never messaged by an upgrade", () => {
    const r = resolveSetting("notify_on_leave", undefined);
    expect(r).toMatchObject({ value: "admin_only", isDefault: true });
    expect(SETTINGS.notify_on_leave.type).toBe("enum");
    expect(SETTINGS.notify_on_leave.options).toEqual(NOTIFY_ON_LEAVE_OPTIONS);
  });

  test("a valid override resolves to the opt-in value (AC-2 gate)", () => {
    expect(resolveSetting("notify_on_leave", "admin_and_teacher")).toEqual({
      value: "admin_and_teacher",
      isDefault: false,
    });
  });

  test("junk / a number / an unknown option → falls back to admin_only and says why (never 'no rule')", () => {
    for (const bad of ["ADMIN_ONLY", "everyone", 1, true, {}]) {
      const r = resolveSetting("notify_on_leave", bad);
      expect(r.value).toBe("admin_only");
      expect(r.isDefault).toBe(true);
      expect(r.reason).toBeString();
    }
  });

  test("the numeric rules are untouched by the enum extension", () => {
    expect(resolveSetting("checkin_early_minutes", 45)).toEqual({ value: 45, isDefault: false });
    expect(resolveSetting("teacher_change_notice_days", undefined).value).toBe(3);
  });
});

describe("leave messages (REQ-049 wording, AC-7)", () => {
  const ctx = { studentName: "น้องซี", teacherNickname: "ก้อง", subject: "Surfskate", date: "2026-09-01", startTime: "10:00" };

  test("teacher message names student, slot and program, and says the slot is free", () => {
    const th = formatOutboxMessage({ kind: "leave_teacher", studentName: "น้องซี" }, ctx, "TH");
    expect(th).toBe("น้องซี ลาคาบ 2026-09-01 10:00 น. (Surfskate) — ช่วงเวลานี้ว่างแล้วค่ะ");
    expect(formatOutboxMessage({ kind: "leave_teacher" }, ctx, "EN")).toBe(
      "น้องซี has cancelled 2026-09-01 10:00 (Surfskate) — that slot is now free.",
    );
  });

  test("admin message carries who reported it", () => {
    const msg = formatOutboxMessage({ kind: "sick_leave", studentName: "น้องซี", via: "line" }, ctx, "TH");
    expect(msg).toContain("แจ้งลา");
    expect(msg).toContain("ครูก้อง");
    expect(msg).toContain("Surfskate");
    expect(msg).toContain("LINE");
  });

  test("a missing field renders '-', never a raw {placeholder}", () => {
    const msg = formatOutboxMessage({ kind: "leave_teacher" }, {}, "TH");
    expect(msg).not.toContain("{");
    expect(msg).toContain("-");
  });
});
