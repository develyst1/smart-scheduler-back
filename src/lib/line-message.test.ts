import { describe, expect, test } from "bun:test";
import { formatOutboxMessage } from "./line-message";

describe("LINE outbox message formatting (B.3)", () => {
  test("booking_confirmed → teacher message with details", () => {
    const msg = formatOutboxMessage(
      { kind: "booking_confirmed" },
      { studentName: "น้องเอ", subject: "คณิต", date: "2026-07-01", startTime: "13:00", endTime: "14:00" },
    );
    expect(msg).toContain("ยืนยันตารางสอน");
    expect(msg).toContain("น้องเอ");
    expect(msg).toContain("คณิต");
    expect(msg).toContain("2026-07-01 13:00-14:00");
  });

  test("reschedule_requested → parent message with old + proposed slot", () => {
    const msg = formatOutboxMessage(
      { kind: "reschedule_requested", to: { date: "2026-07-03", startTime: "10:00" } },
      { studentName: "น้องบี", date: "2026-07-01", startTime: "13:00" },
    );
    expect(msg).toContain("แจ้งขอย้ายคาบเรียน");
    expect(msg).toContain("คาบเดิม: 2026-07-01 13:00");
    expect(msg).toContain("ปลายทางที่เสนอ: 2026-07-03 10:00");
  });

  test("missing context lines are omitted (no 'undefined')", () => {
    const msg = formatOutboxMessage({ kind: "booking_confirmed" }, {});
    expect(msg).not.toContain("undefined");
    expect(msg).toContain("ยืนยันตารางสอน");
  });

  test("sick_leave → admin alert", () => {
    const msg = formatOutboxMessage(
      { kind: "sick_leave", studentName: "น้องซี", via: "line" },
      { date: "2026-07-01", startTime: "10:00" },
    );
    expect(msg).toContain("แจ้งลา");
    expect(msg).toContain("น้องซี");
  });

  test("teacher_assigned / teacher_unassigned → distinct titles, shared body (TASK-094)", () => {
    const ctx = { studentName: "น้องดี", subject: "อังกฤษ", date: "2026-08-20", startTime: "16:00", endTime: "17:00" };
    const assigned = formatOutboxMessage({ kind: "teacher_assigned" }, ctx);
    expect(assigned).toContain("ได้รับมอบหมาย");
    expect(assigned).toContain("น้องดี");
    expect(assigned).toContain("2026-08-20 16:00-17:00");

    const unassigned = formatOutboxMessage({ kind: "teacher_unassigned" }, ctx);
    expect(unassigned).toContain("ย้ายออกจากตาราง");
    expect(unassigned).toContain("น้องดี");
    // EN falls through cleanly too
    expect(formatOutboxMessage({ kind: "teacher_assigned" }, ctx, "EN")).toContain("assigned to you");
  });

  test("unknown kind → generic fallback", () => {
    expect(formatOutboxMessage({ kind: "something_else" })).toContain("แจ้งเตือนจากระบบ");
    expect(formatOutboxMessage({})).toContain("แจ้งเตือนจากระบบ");
  });
});

// ═══ SPEC-066 / TASK-201 (REQ-072) — ONE message for a whole course ═══
//
// The point of this feature is that a teacher gets **one** message for one decision. These tests are about
// what that message has to say to be worth reading at all: which family, which slot, and what they have
// already told us they will miss.
describe("course_confirmed (TASK-201)", () => {
  const payload = {
    kind: "course_confirmed",
    courseId: "c1",
    studentName: "น้องเอ",
    subject: "Surfskate",
    startDate: "2026-09-06",
    weekday: 0,
    startTime: "10:00",
    confirmed: 10,
    plannedLeaves: 2,
    note: "แพ้ถั่ว",
  };

  test("TH: the slot is named in words, not a weekday number", () => {
    const out = formatOutboxMessage(payload, {}, "TH");
    expect(out).toContain("📅 ยืนยันคอร์สแล้ว");
    expect(out).toContain("น้องเอ");
    expect(out).toContain("อาทิตย์ 10:00"); // a teacher reads "Sunday", never "0"
    expect(out).toContain("10");
  });

  test("EN renders the same facts", () => {
    const out = formatOutboxMessage(payload, {}, "EN");
    expect(out).toContain("Course schedule confirmed");
    expect(out).toContain("Sunday 10:00");
  });

  test("🔑 planned leaves are shown when there are any — the schedule is wrong without them", () => {
    expect(formatOutboxMessage(payload, {}, "TH")).toContain("แจ้งลาล่วงหน้าไว้");
  });

  test("…and the line is ABSENT at zero — a '0' reads as a problem to a teacher scanning it", () => {
    const none = { ...payload, plannedLeaves: 0 };
    expect(formatOutboxMessage(none, {}, "TH")).not.toContain("แจ้งลาล่วงหน้าไว้");
  });

  test("everything it needs is in the PAYLOAD — it renders with no booking context at all", () => {
    // A course summary is not a fact about any one session; enriching it from a booking would make the
    // message depend on which session happened to be referenced.
    const out = formatOutboxMessage(payload, {}, "TH");
    expect(out).toContain("2026-09-06");
    expect(out).toContain("Surfskate");
  });

  test("a missing note simply does not appear (no empty label)", () => {
    const { note: _n, ...withoutNote } = payload;
    expect(formatOutboxMessage(withoutNote, {}, "TH")).not.toContain("หมายเหตุ");
  });
});
