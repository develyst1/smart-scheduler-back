// Outbox payload → LINE message text (TH/EN — REQ-015/TASK-039). Pure (no IO) so it is unit-testable.
// The worker enriches with booking details (student/teacher/subject/time) when the row references a booking,
// and passes the recipient's language; everything is optional so a deleted booking still sends. Default TH.

import { t, type Lang } from "./line-i18n";
import { buildDigestMessage } from "./attention";
import { renderSchedule, type SchedRow } from "./line-schedule";

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
    // SPEC-066 / TASK-208 (REQ-072 3B) — the 08:15 "you have a class today" push.
    //
    // 🔴 It calls `renderSchedule` — **the owner-verified `ตารางวันนี้` composer** — rather than formatting a
    // second version of the same list here. The owner has already read that layout on a phone; a second format
    // would be a second thing to get wrong and a second thing to re-verify.
    case "daily_reminder":
      return renderSchedule((payload.rows as SchedRow[]) ?? [], lang, "today");
    // SPEC-066 / TASK-201 (REQ-072) — ONE message for a whole course.
    //
    // 🔴 Everything it needs is IN THE PAYLOAD, not enriched from a booking. A course summary is not a fact
    // about any one session, and asking the worker to re-derive "the schedule" from a booking it happens to
    // reference would make the message depend on which session was picked. `sick_leave` already carries its own
    // fields for the same reason.
    case "course_confirmed": {
      const dow = payload.weekday != null ? t(`ob_dow_${payload.weekday}`, lang) : undefined;
      const schedule = dow && payload.startTime ? `${dow} ${payload.startTime}` : (dow ?? undefined);
      // 🔴 TASK-206 — the DAYS, not a tally. The owner asked "ลาล่วงหน้าวันไหนบ้าง"; a teacher who reads
      // "2 planned leaves" knows the schedule they just confirmed is wrong somewhere and not where. Rendered
      // as a comma-joined dated list, in order.
      const plannedDates = Array.isArray(payload.plannedLeaveDates)
        ? (payload.plannedLeaveDates as string[])
        : [];
      return (
        t("ob_course_title", lang) + "\n" +
        line(t("ob_l_student", lang), payload.studentName as string) +
        line(t("ob_l_subject", lang), payload.subject as string) +
        line(t("ob_l_start", lang), payload.startDate as string) +
        line(t("ob_l_schedule", lang), schedule) +
        line(t("ob_l_sessions", lang), String(payload.confirmed ?? 0)) +
        // Only when there IS one — an empty "leave" line reads as a problem to a teacher scanning the message.
        (plannedDates.length ? line(t("ob_l_planned_leave", lang), plannedDates.join(", ")) : "") +
        line(t("ob_l_note", lang), (payload.note as string) || undefined)
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
    // REQ-049 / TASK-136 — admin and teacher read the same event in their own language, each in the REQ's
    // wording. `-` rather than an empty gap when a field is missing (a deleted booking still sends).
    case "sick_leave":
      return (
        t("ob_sick_title", lang) + "\n" +
        t("ob_leave_admin", lang, {
          student: (payload.studentName as string) || ctx.studentName || "-",
          date: ctx.date ?? "-",
          time: ctx.startTime ?? "-",
          teacher: ctx.teacherNickname ?? "-",
          program: ctx.subject ?? "-",
          by: payload.via === "line" ? t("ob_ch_line", lang) : t("ob_ch_system", lang),
        })
      ).trimEnd();
    case "leave_teacher":
      return t("ob_leave_teacher", lang, {
        student: (payload.studentName as string) || ctx.studentName || "-",
        date: ctx.date ?? "-",
        time: ctx.startTime ?? "-",
        program: ctx.subject ?? "-",
      });
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
