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
    plannedLeaveDates: ["2026-09-14", "2026-09-28"],
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

  test("🔴 TASK-206: the planned leaves are DATES, not a count — the owner asked WHICH DAYS", () => {
    // "2 planned leaves" tells a teacher the schedule they just confirmed is wrong somewhere, and not where.
    // This asserts the RENDERED STRING, because a `plannedLeaves: 2` field compiled perfectly and was useless.
    const out = formatOutboxMessage(payload, {}, "TH");
    expect(out).toContain("แจ้งลาล่วงหน้าไว้");
    expect(out).toContain("2026-09-14");
    expect(out).toContain("2026-09-28");
    // …and the leave line is never a bare tally: what follows the label is a date, not "2".
    const leaveLine = out.split("\n").find((l) => l.includes("ลาล่วงหน้า"))!;
    expect(leaveLine).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(leaveLine.trim().endsWith(": 2")).toBe(false);
  });

  test("dates render in order, comma-separated — a teacher reads it as a list of days", () => {
    const scrambled = { ...payload, plannedLeaveDates: ["2026-09-14", "2026-09-28"] };
    const out = formatOutboxMessage(scrambled, {}, "EN");
    expect(out).toContain("2026-09-14, 2026-09-28");
  });

  test("…and the line is ABSENT when there are none — an empty leave line reads as a problem", () => {
    const none = { ...payload, plannedLeaveDates: [] };
    expect(formatOutboxMessage(none, {}, "TH")).not.toContain("แจ้งลาล่วงหน้าไว้");
    // A payload that never carried the field at all must behave the same, not crash.
    const { plannedLeaveDates: _d, ...missing } = payload;
    expect(formatOutboxMessage(missing, {}, "TH")).not.toContain("แจ้งลาล่วงหน้าไว้");
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

// ═══ SPEC-066 / TASK-208 (REQ-072 3B) — the reminder reuses the verified composer ═══
describe("daily_reminder (TASK-208)", () => {
  const rows = [
    { date: "2026-09-05", startTime: "09:00:00", studentName: "น้องเอ", subjectName: "Surfskate", status: "CONFIRMED" },
    { date: "2026-09-05", startTime: "11:00:00", studentName: "น้องบี", subjectName: "Bike", status: "PENDING" },
  ];

  test("🔴 it renders as ตารางวันนี้ — the layout the owner has already read on a phone", () => {
    const out = formatOutboxMessage({ kind: "daily_reminder", rows }, {}, "TH");
    expect(out).toContain("🗓️ ตารางวันนี้");
    expect(out).toContain("09:00  น้องเอ");
    expect(out).toContain("11:00  น้องบี");
  });

  test("one message lists every session that person has today — not one message each", () => {
    const out = formatOutboxMessage({ kind: "daily_reminder", rows }, {}, "TH");
    expect(out.split("\n").filter((l) => /^\d{2}:\d{2} /.test(l))).toHaveLength(2);
  });

  test("EN renders the same list", () => {
    expect(formatOutboxMessage({ kind: "daily_reminder", rows }, {}, "EN")).toContain("Today's schedule");
  });

  test("a malformed payload degrades to the empty-state, never a crash in the worker", () => {
    // The worker renders whatever is in the outbox, including rows queued by an older deploy.
    expect(formatOutboxMessage({ kind: "daily_reminder" }, {}, "TH")).toContain("ไม่มีคาบสอนในช่วงนี้");
  });
});

// ═══ TASK-219 (REQ-007's missing half) — the note reaches the teacher on the booking they read ═══
//
// The owner proved the gap by typing a note and getting a confirmation without it. `course_confirmed` has
// carried the note since TASK-201; `booking_confirmed` — the message a teacher actually reads on the day —
// did not. These assert the RENDERED STRING both ways, because a payload field that is present and unrendered
// looks identical to one that was never sent.
describe("booking_confirmed carries the attendee note (TASK-219)", () => {
  const ctx = { studentName: "น้องเอ", subject: "Surfskate", date: "2026-09-05", startTime: "10:00" };

  test("🔴 the note is rendered when there is one", () => {
    const out = formatOutboxMessage({ kind: "booking_confirmed", attendeeNote: "แพ้ถั่ว" }, ctx, "TH");
    expect(out).toContain("หมายเหตุ");
    expect(out).toContain("แพ้ถั่ว");
  });

  test("EN renders it too", () => {
    const out = formatOutboxMessage({ kind: "booking_confirmed", attendeeNote: "peanut allergy" }, ctx, "EN");
    expect(out).toContain("peanut allergy");
  });

  test("🔴 the line is ABSENT when there is no note — an empty label reads as a note that went missing", () => {
    for (const payload of [
      { kind: "booking_confirmed" },
      { kind: "booking_confirmed", attendeeNote: null },
      { kind: "booking_confirmed", attendeeNote: "" },
    ]) {
      const out = formatOutboxMessage(payload, ctx, "TH");
      expect(out).not.toContain("หมายเหตุ");
      expect(out).not.toContain("undefined");
    }
  });

  test("🔑 the note comes from the PAYLOAD, not the enriched booking context", () => {
    // The worker builds `ctx` from the row the outbox references; the note must survive a row that was since
    // edited or deleted — the same reason `sick_leave` carries its own student name.
    const out = formatOutboxMessage({ kind: "booking_confirmed", attendeeNote: "จากpayload" }, {}, "TH");
    expect(out).toContain("จากpayload");
  });

  test("the fields the message already had are unchanged (regression)", () => {
    const out = formatOutboxMessage({ kind: "booking_confirmed", attendeeNote: "x" }, ctx, "TH");
    expect(out).toContain("ยืนยันตารางสอน");
    expect(out).toContain("น้องเอ");
    expect(out).toContain("2026-09-05 10:00");
  });
});
