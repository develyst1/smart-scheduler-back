// Outbox payload → LINE message text (TH/EN — REQ-015/TASK-039). Pure (no IO) so it is unit-testable.
// The worker enriches with booking details (student/teacher/subject/time) when the row references a booking,
// and passes the recipient's language; everything is optional so a deleted booking still sends. Default TH.

import { t, type Lang } from "./line-i18n";
import { weekdayOf } from "./recurring";
import { buildDigestMessage } from "./attention";
import { renderTodaySchedule, type TodayRow } from "./line-today-schedule";
import {
  notifyTypeOf,
  programLabel,
  renderFieldBlock,
  TEMPLATE_LANG,
  TEMPLATE_NONE,
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
      // 🔴 REQ-085 §7.3 (TASK-303) — **REPLACED, not edited.** Every label changed and `เวลา` split in two:
      //
      //   FROM  ยืนยันตารางสอน · นักเรียน: · วิชา: · เวลา: 2026-09-08 10:00-11:00
      //   TO    CONFIRMED SCHEDULE: · Student : · Program : · Date : Tuesday · Time : 11:00-12:00 · Remark :
      //
      // 🔑 **The calendar DATE disappears from the message entirely** — `Date` names a WEEKDAY, as §7.1 does,
      // so it is the product's convention rather than one message's quirk. That absence is the whole of what
      // the split did, and it is asserted as an absence.
      //
      // ⚠️ §3's trap, and it points the other way from the message finished an hour before this one: §7.1 has
      // TWO opposite empty-field rules; **§7.3 has only ONE.** There is no `Advance Leave Notice` here and
      // **no `(-)` to inherit** — `Remark` is `*ถ้ามี`, absent entirely when there is none.
      //
      // 📌 §4 — this is the highest-volume notification in the product: a parent, per booking, on the
      // ordinary path. A break here is not a wrong label on a screen someone can re-read; it is a wrong
      // message in a family's LINE, unrecallable. Its byte-for-byte pin was REWRITTEN to this text, never
      // deleted.
      const sessionType = notifyTypeOf(payload.bookingType as string);
      return (
        t("ob_course_title", lang) + "\n" +
        renderFieldBlock(
          "session_confirmed",
          {
            student: ctx.studentName,
            // 🚫 Not a second program string: `programLabel` is what §7.1 prints, and for an อื่นๆ booking it
            // returns the title the admin typed — which is how that booking keeps its name now that the
            // unlabelled title line is gone with the old format (TASK-228 AC-16's rule, one label over).
            program: programLabel(sessionType, {
              subject: ctx.subject,
              size: payload.size as number,
              title: ctx.title,
            }),
            // 🔑 The weekday, through the SAME lookup and the SAME `TEMPLATE_LANG` §7.1 uses. 🚫 Not a second
            // dow table and not a second English rule.
            date: ctx.date ? t(`ob_dow_${weekdayOf(ctx.date)}`, TEMPLATE_LANG) : undefined,
            time: ctx.startTime
              ? `${ctx.startTime}${ctx.endTime ? `-${ctx.endTime}` : ""}`
              : undefined,
          },
          { type: sessionType, audience: recipientType, lang },
        ) +
        // 🔑 The SAME `ob_f_note` label and the SAME appended-`extra` shape §7.1 uses, so `Remark` means one
        // thing across both messages and the omit-empty rule is not written twice.
        // 📌 It comes from the PAYLOAD, not `ctx`: the worker enriches `ctx` from the booking row it points
        // at, and the note must survive a row that has since been edited or deleted.
        extra(t("ob_f_note", lang), (payload.attendeeNote as string) || undefined)
      );
    }
    // 🔴 REQ-085 §2 / §7.4 / §9.1 (TASK-305) — **the message that did not exist.** The owner raised it
    // twice: *"ของแจ้งเตือนครูเด็กลายังไม่ขึ้น"*. A parent declares leave, the parent is told, and the coach
    // is not — so a coach can arrive for a session the student cancelled, and the admin who covers every
    // coach learns nothing either.
    //
    // 🔑 `Coach` is on it for the ADMIN, not the teacher: the teacher reads this in their own chat and
    // already knows the class is theirs; the admin reads every coach's, and without the line three leaves
    // from three teachers in one day arrive looking identical.
    //
    // ⚠️ `Remark` is the `*ถ้ามี` kind and this message has **no `(-)` rule at all** — §9.1 says so in as
    // many words, and it is the fourth message running where the risk was carrying a rule across rather
    // than forgetting one. 📌 Its value here is specific: a Remark is usually about PREPARATION
    // (*"เตรียมเฉพาะ Freeskate ให้น้อง"*), so a coach who learns of a leave also learns there is nothing to
    // prepare.
    case "leave_notice": {
      const leaveType = notifyTypeOf(payload.bookingType as string);
      return (
        t("ob_leave_notice_title", lang) + "\n" +
        renderFieldBlock(
          "leave_notice",
          {
            student: ctx.studentName ?? ((payload.studentName as string) || undefined),
            program: programLabel(leaveType, {
              subject: ctx.subject,
              size: payload.size as number,
              title: ctx.title,
            }),
            date: ctx.date ? t(`ob_dow_${weekdayOf(ctx.date)}`, TEMPLATE_LANG) : undefined,
            time: ctx.startTime
              ? `${ctx.startTime}${ctx.endTime ? `-${ctx.endTime}` : ""}`
              : undefined,
            coach: ctx.coach,
          },
          { type: leaveType, audience: recipientType, lang },
        ) +
        extra(t("ob_f_note", lang), (payload.attendeeNote as string) || undefined)
      );
    }
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
      // 🔴 REQ-085 §7.1(b) — `Date` is an ENGLISH WEEKDAY, in both languages. It rendered `Date : อังคาร`,
      // which is `REQ-079 §18`'s ruling (notification labels are English) simply never applied to a value.
      // 🔑 The weekday is a value WE generate, so it follows the template's convention; the student's name
      // and the admin's `Remark` are a human's words and never do.
      const dow =
        payload.weekday != null ? t(`ob_dow_${payload.weekday}`, TEMPLATE_LANG) : undefined;
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
            // 🔴 Resolved HERE, before the block sees it, precisely so the omit-empty rule cannot swallow it:
            // a parent reading this to check whether their leave was recorded must be answered, and an absent
            // line does not answer.
            // 📌 REQ-085 §7.1(c) — `(-)`, not `ไม่มี`: a system-generated value, so it follows the template's
            // convention like the weekday above. ⚠️ `Remark` two lines down obeys the OPPOSITE rule and is
            // absent entirely when empty — §8.1's trap, and the two need separate assertions.
            advanceLeave: plannedDates.length ? plannedDates.join(", ") : TEMPLATE_NONE,
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
        // 🔴 TASK-269 §1 — `Sessions` is the course AS BOUGHT, and it reads **the same field `programLabel`
        // reads**. It used to be `payload.confirmed`, the count of rows this confirm flipped — so a
        // `Surfskate 10 HR` with two declared leaves printed `Program : Surfskate 10 HR` and
        // `Sessions : 8` **in the same message**: two derivations of one fact, disagreeing, in front of a
        // parent. An advance leave is `SICK_LEAVE` and was never `PENDING`.
        //
        // 🚫 NOT `confirmed + plannedLeaveDates.length`. That patches the reported symptom and leaves two:
        // a re-confirm counts 0, and a session that failed on budget is subtracted with no sign. **A
        // derived figure can disagree with the one printed beside it; a shared field cannot.**
        //
        // ⚠️ Omitted when `size` is absent — `Sessions : 0` on a course is a false statement, not a blank.
        extra(t("ob_f_sessions", lang), payload.size != null ? String(payload.size) : undefined) +
        // TASK-269 §2 — the label is `Remark` (both languages; the house style is English labels for
        // everyone). 🚫 `ob_l_note` is a DIFFERENT key and is untouched: it renders `booking_confirmed`,
        // which is owner-verified and byte-frozen. Two keys is why this is a one-line change.
        //
        // 📌 Where the note comes from, and why it is right: the payload's `note` is
        // `rows[0]?.attendeeNote` with `rows` ordered `asc(date)` ⇒ **the earliest session's note**.
        // TASK-178 writes one note at creation onto EVERY session, so on the normal path every row carries
        // the same string. ⚠️ `setAttendeeNote` edits ONE booking, so after a per-session edit only a note
        // on the earliest session reaches here. **Known and deliberately not fixed:** a course summary has
        // no true answer to "which session's note" when they differ, and inventing one is worse.
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
    // SPEC-075 / TASK-260 (REQ-076 AC-7) — the two teacher messages for a hold and its return.
    //
    // 🔑 Both read the SAME enriched booking the worker already loads, so the date they name is the one the row
    // carries: on a pause that is *the slot it came from*, on a resume it is the new one. Nothing here computes
    // a date, which is why "no new date yet" can be stated as a fact rather than as a guess.
    // 📌 @Porter's copy verbatim; `-` where a field is missing, the same convention `sick_leave` uses so a
    // deleted student still sends rather than throwing.
    case "booking_paused":
    case "booking_resumed":
      return t(payload.kind === "booking_paused" ? "ob_paused" : "ob_resumed", lang, {
        student: (payload.studentName as string) || ctx.studentName || ctx.title || "-",
        date: ctx.date ?? "-",
        time: ctx.startTime ?? "-",
      });
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
