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

  test("unknown kind → generic fallback", () => {
    expect(formatOutboxMessage({ kind: "something_else" })).toContain("แจ้งเตือนจากระบบ");
    expect(formatOutboxMessage({})).toContain("แจ้งเตือนจากระบบ");
  });
});
