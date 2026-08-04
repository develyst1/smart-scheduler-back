// Outbox payload → LINE message text (TH/EN — REQ-015/TASK-039). Pure (no IO) so it is unit-testable.
// The worker enriches with booking details (student/teacher/subject/time) when the row references a booking,
// and passes the recipient's language; everything is optional so a deleted booking still sends. Default TH.

import { t, type Lang } from "./line-i18n";
import { buildDigestMessage } from "./attention";

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

export function formatOutboxMessage(payload: OutboxPayload, ctx: MessageContext = {}, lang: Lang = "TH"): string {
  switch (payload?.kind) {
    case "booking_confirmed": {
      const when =
        ctx.date && ctx.startTime ? `${ctx.date} ${ctx.startTime}${ctx.endTime ? `-${ctx.endTime}` : ""}` : undefined;
      return (
        t("ob_confirmed_title", lang) + "\n" +
        line(t("ob_l_student", lang), ctx.studentName) +
        line(t("ob_l_subject", lang), ctx.subject) +
        line(t("ob_l_time", lang), when)
      ).trimEnd();
    }
    case "reschedule_requested": {
      const target =
        payload.to?.date && payload.to?.startTime
          ? `${payload.to.date} ${payload.to.startTime}`
          : undefined;
      return (
        t("ob_reschedule_title", lang) + "\n" +
        line(t("ob_l_student", lang), ctx.studentName) +
        line(t("ob_l_oldslot", lang), ctx.date && ctx.startTime ? `${ctx.date} ${ctx.startTime}` : undefined) +
        line(t("ob_l_target", lang), target) +
        t("ob_reschedule_foot", lang)
      ).trimEnd();
    }
    case "sick_leave":
      return (
        t("ob_sick_title", lang) + "\n" +
        line(t("ob_l_student", lang), (payload.studentName as string) ?? ctx.studentName) +
        line(t("ob_l_class", lang), ctx.date && ctx.startTime ? `${ctx.date} ${ctx.startTime}` : undefined) +
        line(t("ob_l_channel", lang), payload.via === "line" ? t("ob_ch_line", lang) : t("ob_ch_system", lang))
      ).trimEnd();
    // TASK-094: teacher reassigned on a course session — same body as a confirmation, different title per side.
    case "teacher_assigned":
    case "teacher_unassigned": {
      const when =
        ctx.date && ctx.startTime ? `${ctx.date} ${ctx.startTime}${ctx.endTime ? `-${ctx.endTime}` : ""}` : undefined;
      const title = payload.kind === "teacher_assigned" ? "ob_teacher_assigned_title" : "ob_teacher_unassigned_title";
      return (
        t(title, lang) + "\n" +
        line(t("ob_l_student", lang), ctx.studentName) +
        line(t("ob_l_subject", lang), ctx.subject) +
        line(t("ob_l_time", lang), when)
      ).trimEnd();
    }
    // REQ-023: the daily digest travels as its check results, so it renders in each admin's own language.
    case "daily_digest":
      return buildDigestMessage((payload.checks as any[]) ?? [], lang);
    default:
      return t("ob_default", lang);
  }
}
