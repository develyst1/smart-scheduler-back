// Outbox payload → LINE message text (TH/EN — REQ-015/TASK-039). Pure (no IO) so it is unit-testable.
// The worker enriches with booking details (student/teacher/subject/time) when the row references a booking,
// and passes the recipient's language; everything is optional so a deleted booking still sends. Default TH.

import { t, type Lang } from "./line-i18n";
import { buildDigestMessage } from "./attention";
import { renderTodaySchedule, type TodayRow } from "./line-today-schedule";
import {
  notifyTypeOf,
  programLabel,
  renderFieldBlock,
  type Audience,
  type FieldKey,
  type NotifyType,
  type TemplateKey,
} from "./line-message-fields";

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
  /**
   * SPEC-070 / TASK-228 (REQ-078 AC-16) — the admin's typed title for an อื่นๆ booking. Absent for the four
   * lesson types, which is exactly why nothing about their messages changes.
   */
  title?: string;
  /**
   * SPEC-072 / TASK-253 (REQ-077) — every assigned teacher, joined into ONE `Coach` field. `teacherNickname`
   * above stays the primary alone: it feeds the shipped `sick_leave` wording, which names the teacher of the
   * class and must not change.
   */
  coach?: string;
}

const line = (label: string, value?: string) => (value ? `${label}: ${value}\n` : "");

/**
 * 🔴 TASK-257 §3 — a line APPENDED to a REQ-077 block, in the customer's convention (` : `, English label).
 *
 * The cause it removes: `line()` above is the OLD convention (`label: value`, bilingual labels), and the two
 * survive side by side only because `booking_confirmed` is byte-frozen on the old one. Anything printed inside
 * or beside a REQ-077 message goes through here or through `fieldLines`; nothing else may.
 */
const extra = (label: string, value?: string) => (value ? `${label} : ${value}\n` : "");

/**
 * @param recipientType WHO is reading this. The outbox row has always carried it and the worker simply never
 * forwarded it, which is why *"the teacher's copy loses the family's private lines"* could not be expressed.
 * Defaults to `parent` — the fuller message — so a caller that has not been updated cannot silently strip
 * lines from someone entitled to them.
 */
export function formatOutboxMessage(
  payload: OutboxPayload,
  ctx: MessageContext = {},
  lang: Lang = "TH",
  recipientType: Audience = "parent",
): string {
  switch (payload?.kind) {
    case "booking_confirmed": {
      const when =
        ctx.date && ctx.startTime ? `${ctx.date} ${ctx.startTime}${ctx.endTime ? `-${ctx.endTime}` : ""}` : undefined;
      return (
        t("ob_confirmed_title", lang) + "\n" +
        // 🔴 SPEC-070 / TASK-228 (AC-16) — an อื่นๆ booking is named by the title the admin typed, and the
        // title stands on its OWN LINE with no label. It is not a student, so putting it behind
        // `ob_l_student` would state something false; and it is never the words "อื่นๆ" / "Other" — being
        // asked to type a real name is the entire point of the field (REQ-078 📌).
        //
        // Absent for the four lesson types, so their messages are byte-identical: this line renders to "".
        (ctx.title ? `${ctx.title}\n` : "") +
        // `line()` already omits a field with no value, which is what makes a studentless / programless
        // booking come out with no empty labels — TASK-219's lesson: a blank label reads as information that
        // went missing, not as information that does not exist.
        line(t("ob_l_student", lang), ctx.studentName) +
        line(t("ob_l_subject", lang), ctx.subject) +
        line(t("ob_l_time", lang), when) +
        // 🔴 TASK-219 (REQ-007's missing half) — the note reaches the teacher on the day's own booking.
        // `course_confirmed` has carried it since TASK-201; this template did not, so a note typed at booking
        // ("แพ้ถั่ว", "มาสาย 10 นาที") went to the one message the teacher actually reads and vanished.
        //
        // It comes from the PAYLOAD, not `ctx`: the worker enriches `ctx` from the booking row it references,
        // and the note must survive even for a row that has since been edited or deleted — the same reason
        // `sick_leave` carries its own student name.
        //
        // Omitted when there is none. An empty "note:" line is a defect, not a blank: it reads as a note the
        // teacher failed to receive.
        line(t("ob_l_note", lang), (payload.attendeeNote as string) || undefined)
      ).trimEnd();
    }
    // SPEC-066 / TASK-208 (REQ-072 3B) — the 08:15 "you have a class today" push.
    //
    // 🔴 SPEC-072 / TASK-256 — re-cut to REQ-077 Parent 2 (@Porter's Decision 6): the customer's own block, once
    // per class, under a header carrying whatever is genuinely constant. One class renders EXACTLY as their
    // template, which is the common case.
    //
    // 🚫 `renderSchedule` — the owner-verified `ตารางวันนี้` composer — is deliberately NOT deleted: it still
    // serves the teacher's `ตาราง` command, and it is the fallback if the customer prefers what they have been
    // reading for weeks. This change is in @Porter's review batch with the other five decisions.
    case "daily_reminder":
      return renderTodaySchedule((payload.rows as TodayRow[]) ?? [], lang, recipientType);
    // SPEC-066 / TASK-201 (REQ-072) — ONE message for a whole course.
    //
    // 🔴 Everything it needs is IN THE PAYLOAD, not enriched from a booking. A course summary is not a fact
    // about any one session, and asking the worker to re-derive "the schedule" from a booking it happens to
    // reference would make the message depend on which session was picked. `sick_leave` already carries its own
    // fields for the same reason.
    case "course_confirmed": {
      // 🔴 TASK-257 §2 — `Date` is the WEEKDAY ALONE and `Time` is a RANGE.
      //
      // It used to print `Date : อาทิตย์ 10:00` beside `Time : 10:00` — the time twice, neither of them a range,
      // while `COURSE DEDUCTION` printed `Time : 10:00-11:00`. **Two messages disagreeing about what `Time`
      // means is the kind of difference a customer reads as an error rather than a preference.**
      // 📌 The range is built from `endTime` on the payload, derived ONCE where the payload is built
      // (`addHour`, the same derivation `insertBooking` uses). Deriving +1h here would put that rule in two
      // places, and the next duration change would fix only one of them.
      const dow = payload.weekday != null ? t(`ob_dow_${payload.weekday}`, lang) : undefined;
      const when = payload.startTime
        ? `${payload.startTime}${payload.endTime ? `-${payload.endTime}` : ""}`
        : undefined;
      // 🔴 TASK-206 — the DAYS, not a tally. The owner asked "ลาล่วงหน้าวันไหนบ้าง"; a teacher who reads
      // "2 planned leaves" knows the schedule they just confirmed is wrong somewhere and not where. Rendered
      // as a comma-joined dated list, in order.
      const plannedDates = Array.isArray(payload.plannedLeaveDates)
        ? (payload.plannedLeaveDates as string[])
        : [];
      // SPEC-072 / TASK-253 — REQ-077 Parent 1 · `CONFIRMED SCHEDULE`, and the teacher's copy of it.
      //
      // 🔑 ONE payload, TWO renderings. Everything below comes from the same object the parent's row and the
      // teacher's row share; `recipientType` only decides which of those facts are printed. A second payload —
      // or a `teacher_course_confirmed` kind — would re-create the exact failure the payload's own comment
      // prevents: the parent and the coach reading a different schedule.
      const type = notifyTypeOf((payload.bookingType as string) ?? "COURSE_PACKAGE");
      return (
        t("ob_course_title", lang) + "\n" +
        renderFieldBlock(
          "confirmed_schedule",
          {
            student: (payload.studentName as string) || undefined,
            program: programLabel(type, {
              subject: payload.subject as string,
              size: payload.size as number,
              title: payload.title as string,
            }),
            date: dow,
            time: when,
            start: (payload.startDate as string) || undefined,
            coach: (payload.coach as string) || undefined,
            expiry: (payload.expiryDate as string) || undefined,
            // 🔴 Resolved to `ไม่มี` HERE, before the block sees it, precisely so the omit-empty rule cannot
            // swallow it: a parent reading this to check whether their leave was recorded must be answered,
            // and an absent line does not answer.
            advanceLeave: plannedDates.length ? plannedDates.join(", ") : t("ob_f_none", lang),
          },
          { type, audience: recipientType, lang },
        ) +
        // 📌 KEPT below the customer's block, deliberately, and one line each to delete if their template is
        // meant to be exhaustive: the confirmed COUNT is what this message exists to announce, and the note is
        // TASK-219's fix — a note typed at booking ("แพ้ถั่ว") reaching the one message a teacher reads.
        // Dropping either would be a regression the templates never asked for. Flagged in the TASK.
        //
        // 🔴 TASK-257 §3 — printed in the CUSTOMER'S convention (English label · ` : `), because a message with
        // two labelling conventions is what put `จำนวนคาบที่ยืนยัน` and `หมายเหตุ` under eight English labels.
        // They cannot reuse `ob_l_*`: those are bilingual, and `ob_l_note` also renders `booking_confirmed`,
        // which is owner-verified and byte-frozen. **One message, one convention** — the cause, not the symptom.
        extra(t("ob_f_sessions", lang), String(payload.confirmed ?? 0)) +
        extra(t("ob_f_note", lang), (payload.note as string) || undefined)
      ).trimEnd();
    }
    // SPEC-072 §3 / TASK-254 (REQ-077 Parent 3) — a session was used, and here is what is left.
    //
    // 🔴 `Remaining` is the balance AFTER the deduction; it arrives already rendered (`2 HR` · `4/6 ครั้ง`)
    // from the write that caused this message, never recomputed here. The money facts are in the payload; the
    // student, program, date, time and coach are enriched from the booking this row points at — the same facts
    // every other booking-based message reads.
    case "course_deduction": {
      const type = notifyTypeOf(payload.bookingType as string);
      const when = ctx.startTime ? `${ctx.startTime}${ctx.endTime ? `-${ctx.endTime}` : ""}` : undefined;
      return (
        t("ob_deduct_title", lang) + "\n" +
        renderFieldBlock(
          "course_deduction",
          {
            student: ctx.studentName,
            program: programLabel(type, { subject: ctx.subject, size: payload.total as number, title: ctx.title }),
            date: ctx.date,
            time: when,
            coach: ctx.coach ?? ctx.teacherNickname,
            remaining: (payload.remaining as string) || undefined,
            expiry: (payload.expiryDate as string) || undefined,
          },
          { type, audience: recipientType, lang },
        )
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
