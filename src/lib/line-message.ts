// Outbox payload → Thai LINE message text. Pure (no IO) so it is unit-testable.
// The worker enriches with booking details (student/teacher/subject/time) when the
// row references a booking; everything is optional so a deleted booking still sends.

export interface OutboxPayload {
  kind?: string;
  to?: { date?: string; startTime?: string };
  [k: string]: unknown;
}

export interface MessageContext {
  studentName?: string;
  teacherNickname?: string;
  subject?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
}

const line = (label: string, value?: string) => (value ? `${label}: ${value}\n` : "");

export function formatOutboxMessage(payload: OutboxPayload, ctx: MessageContext = {}): string {
  switch (payload?.kind) {
    case "booking_confirmed": {
      const when =
        ctx.date && ctx.startTime ? `${ctx.date} ${ctx.startTime}${ctx.endTime ? `-${ctx.endTime}` : ""}` : undefined;
      return (
        "📅 ยืนยันตารางสอน\n" +
        line("นักเรียน", ctx.studentName) +
        line("วิชา", ctx.subject) +
        line("เวลา", when)
      ).trimEnd();
    }
    case "reschedule_requested": {
      const target =
        payload.to?.date && payload.to?.startTime
          ? `${payload.to.date} ${payload.to.startTime}`
          : undefined;
      return (
        "🔔 แจ้งขอย้ายคาบเรียน (มีการจองทับ)\n" +
        line("นักเรียน", ctx.studentName) +
        line("คาบเดิม", ctx.date && ctx.startTime ? `${ctx.date} ${ctx.startTime}` : undefined) +
        line("ปลายทางที่เสนอ", target) +
        "กรุณาติดต่อกลับเพื่อยืนยันการย้าย"
      ).trimEnd();
    }
    case "sick_leave":
      return (
        "🤒 แจ้งลา\n" +
        line("นักเรียน", (payload.studentName as string) ?? ctx.studentName) +
        line("คาบ", ctx.date && ctx.startTime ? `${ctx.date} ${ctx.startTime}` : undefined) +
        line("ช่องทาง", payload.via === "line" ? "LINE" : "ระบบ")
      ).trimEnd();
    default:
      return "🔔 แจ้งเตือนจากระบบตารางเรียน";
  }
}
