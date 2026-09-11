// Outbox payload → LINE message text (TH/EN — REQ-015/TASK-039). Pure (no IO) so it is unit-testable.
// The worker enriches with booking details (student/teacher/subject/time) when the row references a booking,
// and passes the recipient's language; everything is optional so a deleted booking still sends. Default TH.

import { t, type Lang } from "./line-i18n";
import { weekdayOf } from "./recurring";
import { ddmmyyyy } from "./time";
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
 * 🔴 TASK-332 — a payload value as a FIELD: **keeps a legitimate ZERO, drops only true emptiness.**
 *
 * ## 🔑 THE FILE HAS BOTH BUGS, ONE PER IDIOM — and this is the sentence to read before "fixing" either
 * ***`||` eats a legitimate `0`. `??` lets an empty string through.***
 * · `(payload.x as string) || undefined` — `0` is falsy ⇒ the whole LINE disappears (omit-empty).
 * · `String(payload.x ?? "-")` — `""` is neither `null` nor `undefined` ⇒ it renders a HALF-SENTENCE.
 * ⚠️ **So swapping one operator for the other does not fix anything; it trades one failure for its mirror.**
 * 🔑 That is why this is a helper and not an expression: **both conditions have to be stated together, once.**
 *
 * ## Why `Remaining` specifically needed it
 * `Remaining` is **the only field whose absence removes the MESSAGE'S PURPOSE** — a `COURSE DEDUCTION` exists
 * to tell a parent what is left, and without that line it is a receipt with no balance. ⚠️ And omit-empty
 * makes the absence look DELIBERATE (the owner's own `(-)` reasoning, pointed at us) ⇒ **nobody would ever
 * report it.** 🚫 The other nine `|| undefined` sites in this file are CORRECT and stay as they are: an
 * absent `Remark` is the customer's `*ถ้ามี` rule, an absent `expiryDate` is a TRUE statement about a course
 * with no expiry, and an absent `studentName` is TASK-224's own decision about a studentless booking.
 * **Changing them "for consistency" would delete a rule the customer asked for.**
 *
 * ## 🔻 TASK-337 — the FOUR `Remark` sites also use it, and NOT for consistency
 * 🔑 They moved because **their correctness lived in another file.** `(payload.attendeeNote as string) ||
 * undefined` is TRUTHY for `"   "` ⇒ a bare `Remark :` label, TASK-219's *information that went missing*.
 * It has never happened, and the reason it has never happened is upstream of this file:
 * · `attendeeNote` — `validation.ts`'s `z.string().trim().max(200)`, and zod's `.trim()` TRANSFORMS, so a
 *   whitespace-only note is STORED as `""`.
 * · `note` (§7.1) — a different upstream, same effect:
 *   `courseNote`, which rejects a whitespace-only note and returns `null`.
 * ⚠️ **I first reported that hole as LIVE and was wrong** — I had read ONE layer (`setAttendeeNote` stores
 * the note untrimmed) and reported on the PRODUCT. It is LATENT.
 * 🔑 **So the property this buys is not "fixes a bug today" — it is *this guard does not depend on a layer it
 * cannot see*.** That is DEFENCE IN DEPTH, deliberately. **Do not simplify it.** A reader who finds the zod
 * `.trim()` and calls this dead has found the reason it exists, not a reason to delete it.
 * 🚫 And the trim upstream is UNTOUCHED: two guards on one boundary is the point, not one traded for the other.
 */
const fieldValue = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s.trim() ? s : undefined; // `0` → `"0"` · `""` and `"   "` → absent, never a bare label
};

/**
 * 🔴 TASK-345 — a DATE as a field: `fieldValue`'s guard, then `time.ts`'s ONE formatter.
 *
 * 🚫 **This is NOT a second date function and must never become one:** it formats nothing itself, it calls
 * `ddmmyyyy`. ⚠️ **If a second FORMAT is ever wanted it does not go here** — that is a product decision and
 * `REQ-085 §15` is where those live.
 * 🔑 **Why it exists:** `REQ-087 §7` was applied FIVE times in three days, each time to the field somebody
 * was looking at, and every pass undercounted — **5 → 8 → 9+** — because every pass searched the SHAPE OF
 * THE SOURCE. ⇒ ***the sites that leaked were the ones whose field is not called `date`***: `Start`,
 * `*Expiry date`, a joined list of leave dates.
 * 📌 The thing that FINDS them is `no-iso-date-leak.test.ts`, and it reads the OUTPUT, not this.
 */
const dateField = (v: unknown): string | undefined => {
  const s = fieldValue(v);
  return s ? ddmmyyyy(s) : undefined;
};

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
  // 🔴 TASK-325 (`REQ-085 §16.3`) — **THE ONE TRIM, at the builder's exit.** The customer reported it twice:
  // *"เอาช่องว่างด้านล่างของ 📅CONFIRMED SCHEDULE ออกค่ะ ** ในคอมไม่ขึ้น แต่ในโทรศัพท์ขึ้นค่ะ"* — a blank line
  // that shows on a PHONE and not on a desktop, which is why it survived every desktop screenshot.
  //
  // 🔑 It was never one message's bug. `.trimEnd()` sat on FIVE branches out of fourteen kinds, so **nine
  // messages were clean or dirty by accident of which branch someone had happened to trim.** @Porter's ruling
  // was *"reproduced on TWO different messages ⇒ fix where messages are BUILT, not per message"*, and every
  // branch's return passes through here. ⇒ **one property, one place, and a branch added next month inherits
  // it without knowing it exists.**
  // 🚫 The five per-branch trims are GONE — a redundant trim is a second writer that agrees today (TASK-314),
  // and their absence is asserted so a new branch cannot re-add its own.
  return buildOutboxMessage(payload, ctx, lang, recipientType).trimEnd();
}

/** The per-kind bodies. 🚫 Nothing here trims: that is `formatOutboxMessage`'s job, once, above. */
function buildOutboxMessage(
  payload: OutboxPayload,
  ctx: MessageContext,
  lang: Lang,
  recipientType: Audience,
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
            // 🔴 TASK-343 (`REQ-087 §6b`) — **THE REAL DATE.** This said `Friday`, and `§7.1`'s course-wide
            // block says `Friday` too ⇒ ***one conversation delivered `Date : Friday` and `Date : 2026-09-18`
            // to the same parent.*** A per-session confirmation's only job is *THIS class, on THIS day*.
            // 🔑 **`REQ-085 §15` still holds and this makes the product CONSISTENT with it rather than
            // breaking it: WEEKDAY for a COURSE, DATE for a SESSION.** 🚫 `§7.1` is untouched — it reads
            // `payload.weekday`, a different source, so it cannot follow by accident.
            // 🔻 **THIS DEVIATES FROM THE CUSTOMER'S `§7.3`, and the owner is TELLING them, not asking.**
            // 🚫 **Not a placeholder and not unsettled.** 📌 It is their own leave-notice argument —
            // *"ครูจะไม่รู้ว่าแจ้งลา พฤ ไหน"* — applied to a message they had not looked at yet.
            // 📌 `DD-MM-YYYY` via `ddmmyyyy` (TASK-318, `time.ts`), the same format `§9.1` uses and the one
            // they specified for a date of birth in `REQ-079 §17c`. 🚫 No second date helper.
            date: ctx.date ? ddmmyyyy(ctx.date) : undefined,
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
        // 🔑 TASK-337 — `fieldValue`, not `||`. **Defence in depth, not a live-bug fix:** the old guard was
        // correct only because `validation.attendeeNote`'s `z.string().trim()` cannot deliver whitespace —
        // a fact in a file this one cannot see. 🚫 Do not simplify it back; see `fieldValue`'s note.
        extra(t("ob_f_note", lang), fieldValue(payload.attendeeNote))
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
            // 🔴 TASK-318 (`REQ-085 §16d`) — THE ACTUAL DATE, `DD-MM-YYYY`, and it is the whole point of this
            // message. It rendered the WEEKDAY ALONE, so the owner marked two sessions absent and the coach
            // received TWO BYTE-IDENTICAL notices: *"ครูจะไม่รู้ว่าแจ้งลา พฤ ไหน"*. **The sends were correct;
            // the messages could not be told apart.**
            // 🔑 `Date` means different things in a message about a COURSE and one about a SESSION. `§7.1`'s
            // course-wide schedule KEEPS the weekday — it describes a RECURRING SLOT and a single date there
            // would be wrong. **This message's only job is *do not turn up for THIS class*.**
            // 🚫 NOT the picker's `อังคาร 22/09` (TASK-316): that is the parent's surface, this is the
            // customer's own layout for the coach's. **Two surfaces, two audiences, two formats, both right.**
            // 📌 `DD-MM-YYYY` is theirs, and it matches the date of birth they specified in `REQ-079 §17c` —
            // we follow them rather than invent a third style.
            date: ctx.date ? ddmmyyyy(ctx.date) : undefined,
            time: ctx.startTime
              ? `${ctx.startTime}${ctx.endTime ? `-${ctx.endTime}` : ""}`
              : undefined,
            coach: ctx.coach,
          },
          { type: leaveType, audience: recipientType, lang },
        ) +
        // 🔑 TASK-337 — `fieldValue`, not `||`. **Defence in depth, not a live-bug fix:** the old guard was
        // correct only because `validation.attendeeNote`'s `z.string().trim()` cannot deliver whitespace —
        // a fact in a file this one cannot see. 🚫 Do not simplify it back; see `fieldValue`'s note.
        extra(t("ob_f_note", lang), fieldValue(payload.attendeeNote))
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
            // 🔴 TASK-345 — **`Start : 2026-10-16`, and NOBODY had ever reported it.** 📌 *It has no `*` and
            // it is not called `date` — which is exactly why three sweeps walked past it.*
            start: dateField(payload.startDate),
            coach: (payload.coach as string) || undefined,
            // 🔴 TASK-345 — `*Expiry date`, @Porter's second screenshot.
            expiry: dateField(payload.expiryDate),
            // 🔴 Resolved HERE, before the block sees it, precisely so the omit-empty rule cannot swallow it:
            // a parent reading this to check whether their leave was recorded must be answered, and an absent
            // line does not answer.
            // 📌 REQ-085 §7.1(c) — `(-)`, not `ไม่มี`: a system-generated value, so it follows the template's
            // convention like the weekday above. ⚠️ `Remark` two lines down obeys the OPPOSITE rule and is
            // absent entirely when empty — §8.1's trap, and the two need separate assertions.
            // 🔴 TASK-345 — **the declared leave DATES, joined, RAW.** ⚠️ *A LIST of dates: the only site
            // where one field carries several, and the one a per-field sweep is least likely to picture.*
            // 🚫 `TEMPLATE_NONE` is untouched — `§7.1`'s `(-)` empty-field rule is not this task's business.
            advanceLeave: plannedDates.length ? plannedDates.map(ddmmyyyy).join(", ") : TEMPLATE_NONE,
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
        // 🔻 TASK-318 (`REQ-085 §16.4`) — **`Sessions :` is GONE, on the customer's own reasoning: the program
        // name already carries the hours** (*"Freeskate 6 HR"*). ⇒ the line restated what the line above it
        // already said.
        // 📌 TASK-269 §1 had made it read **the same field `programLabel` reads** — it used to be
        // `payload.confirmed`, so a `Surfskate 10 HR` with two declared leaves printed `Program : Surfskate
        // 10 HR` and `Sessions : 8` in one message: two derivations of one fact, disagreeing, in front of a
        // parent. 🔑 **That fix is what makes deleting it safe now** — the two agreed, so nothing is lost with
        // the line; had they still disagreed, removing one would have hidden a defect rather than closed it.
        // 🚫 `Remaining` and `*Expiry date` STAY (`§9`'s conditional pair): they are what tells a coach a
        // COURSE row from a one-off — the owner's *"ไม่งั้นมันจะแยกยังไง"* is their acceptance criterion.
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
        // 🔑 TASK-337 — the FOURTH note rendering, and it moves for the SAME reason with a different
        // upstream: `courseNote` (`course-plan.ts`) is what rejects a whitespace-only note here, not zod.
        // 📌 Included deliberately: leaving one of four notes on a different guard would recreate the very
        // question this task exists to answer — *which of these guards is load-bearing?*
        extra(t("ob_f_note", lang), fieldValue(payload.note))
      );
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
        // 🔴 TASK-335 (`REQ-087 §1a`) — the customer's report: a voucher deduction announced itself as
        // `💡COURSE DEDUCTION`. 🚫 No new payload field — the branch already computes `type` from the
        // `bookingType` `deductionPayload` DECLARES, so the title follows the fact that is already here.
        // 📖 The voucher string is a PLACEHOLDER (@Porter is asking the owner) — pinned by FORM, not bytes.
        t(type === "VOUCHER" ? "ob_deduct_title_voucher" : "ob_deduct_title", lang) + "\n" +
        renderFieldBlock(
          "course_deduction",
          {
            student: ctx.studentName,
            program: programLabel(type, { subject: ctx.subject, size: payload.total as number, title: ctx.title }),
            // 🔴 TASK-344 (`REQ-087 §7`) — owner: *"เอา แก้ให้เป็น 08-09-2026 เหมือนกันทุกที่"*. This rendered
            // the RAW ISO `2026-09-08`. ⚠️ **The third fix to this one message today** (TASK-335's header,
            // TASK-336's `Remark`, now its date) — 📌 *which is the argument for the sweep rather than
            // against it.* 🚫 `ddmmyyyy` from `time.ts`, never a second date function.
            date: ctx.date ? ddmmyyyy(ctx.date) : undefined,
            time: when,
            coach: ctx.coach ?? ctx.teacherNickname,
            // 🔴 TASK-332 — `fieldValue`, not `||`: a balance of ZERO is the most important one this message
            // ever carries, and `0 || undefined` deleted the line that says so. See the helper for why a bare
            // `??` would not have been the fix either.
            remaining: fieldValue(payload.remaining),
            // 🔴 TASK-345 — **@Porter's screenshot: `*Expiry date : 2027-03-11` three lines below
            // `Date : 11-09-2026`** — ⚠️ *one message disagreeing with ITSELF, hours after TASK-344 made the
            // line above right.*
            expiry: dateField(payload.expiryDate),
          },
          { type, audience: recipientType, lang },
        ) +
        // 🔑 TASK-336 (`REQ-087 §1b`) — the session's own `Remark`, owner: *"เพิ่มทั้งคู่เลยไม่ต้องถาม"*.
        // ⚠️ It was NOT a rendering fix: the note reached neither the payload nor `ctx`, so this message has
        // never carried one. **The plumbing was the task** — `notifyCourseDeduction` reads it from the
        // `bookingId` it already takes. 📌 THE SESSION'S note, not `courseNote`'s earliest-in-date-order:
        // a course summary has no true answer to *which session*; a deduction has exactly one.
        // 🚫 Appended by the composer, NOT a template field — adding one would change the byte-pinned
        // course message too. And `*ถ้ามี`: it appears only when a note exists, so no approved message
        // becomes noisier.
        extra(t("ob_f_note", lang), fieldValue(payload.attendeeNote))
      );
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
        // 🔻 TASK-344 — `DD-MM-YYYY`. 📌 ONE branch serving TWO live kinds: a pause AND a resume.
        // 🚫 The `-` fallback is TASK-224's and is untouched: a missing date still reads `-`, not a blank.
        date: ctx.date ? ddmmyyyy(ctx.date) : "-",
        time: ctx.startTime ?? "-",
      });
    case "reschedule_requested": {
      const target =
        payload.to?.date && payload.to?.startTime
          // ⚪ TASK-344 — DEAD branch (no producer), fixed anyway. ⚠️ **NOT a `date:` field** — the date is
          // interpolated into a COMBINED value, which is exactly why a sweep looking for `date:` missed it.
          ? `${ddmmyyyy(payload.to.date as string)} ${payload.to.startTime}`
          : undefined;
      return (
        t("ob_reschedule_title", lang) + "\n" +
        line(t("ob_l_student", lang), ctx.studentName) +
        line(t("ob_l_oldslot", lang), ctx.date && ctx.startTime ? `${ddmmyyyy(ctx.date)} ${ctx.startTime}` : undefined) +
        line(t("ob_l_target", lang), target) +
        t("ob_reschedule_foot", lang)
      );
    }
    // REQ-049 / TASK-136 — admin and teacher read the same event in their own language, each in the REQ's
    // wording. `-` rather than an empty gap when a field is missing (a deleted booking still sends).
    // 🔴 REQ-085 §12 (TASK-309 §3) — the make-up the search had to place half a year out.
    //
    // `firstFreeWeeklySlot` scans 26 weeks and, finding nothing free, returns the last candidate ANYWAY. Its
    // comment said the caller's ceiling refused that answer — and §12 deleted the ceiling, so for one day a
    // make-up could land absurdly far in silence.
    // 🔑 It is still not refused (`§12` forbids that) and it is no longer silent. 🚫 The PARENT is not told:
    // they asked for a leave and got one; the date is our problem, not theirs.
    case "makeup_far_out":
      return (
        t("ob_makeup_far", lang, {
          weeks: String(payload.weeks ?? "-"),
          replaces: (payload.replaces as string) ?? "-",
          landedOn: (payload.landedOn as string) ?? "-",
        }) +
        (ctx.studentName ? `\n${t("ob_l_student", lang)}: ${ctx.studentName}` : "")
      );
    case "sick_leave":
      return (
        t("ob_sick_title", lang) + "\n" +
        t("ob_leave_admin", lang, {
          student: (payload.studentName as string) || ctx.studentName || "-",
          // ⚪ TASK-344 — this branch is DEAD: `sick_leave` has no producer (TASK-333's inventory).
          // ✅ **Fixed anyway, and that is deliberate:** a dead branch rendering the OLD format is a trap for
          // whoever revives it — *they would ship the one message in the product that disagrees.*
          // 🚫 Nothing observable changes here, because nothing sends it.
          date: ctx.date ? ddmmyyyy(ctx.date) : "-",
          time: ctx.startTime ?? "-",
          teacher: ctx.teacherNickname ?? "-",
          program: ctx.subject ?? "-",
          by: payload.via === "line" ? t("ob_ch_line", lang) : t("ob_ch_system", lang),
        })
      );
    case "leave_teacher":
      return t("ob_leave_teacher", lang, {
        student: (payload.studentName as string) || ctx.studentName || "-",
        // ⚪ TASK-344 — DEAD too, same reason and same treatment as `sick_leave` above.
        date: ctx.date ? ddmmyyyy(ctx.date) : "-",
        time: ctx.startTime ?? "-",
        program: ctx.subject ?? "-",
      });
    // TASK-094: teacher reassigned on a course session — same body as a confirmation, different title per side.
    case "teacher_assigned":
    case "teacher_unassigned": {
      // 🔴 TASK-344 — **LIVE, and neither @Sober's candidate list nor my first sweep found it.** Both kinds
      // are produced by `scheduler.service.ts`, and this printed `2026-09-08 10:00-11:00` to a TEACHER.
      // 🔑 **It hid because the date is not in a `date:` field** — it is interpolated into a COMBINED `Time`
      // value, so every sweep that grepped for the field name walked past it.
      const when =
        ctx.date && ctx.startTime ? `${ddmmyyyy(ctx.date)} ${ctx.startTime}${ctx.endTime ? `-${ctx.endTime}` : ""}` : undefined;
      const title = payload.kind === "teacher_assigned" ? "ob_teacher_assigned_title" : "ob_teacher_unassigned_title";
      return (
        t(title, lang) + "\n" +
        line(t("ob_l_student", lang), ctx.studentName) +
        line(t("ob_l_subject", lang), ctx.subject) +
        line(t("ob_l_time", lang), when)
      );
    }
    // 🔴 TASK-334 Part A (`REQ-087`) — an approved teacher is told what the payload already said.
    //
    // ⚠️ The failure was silent in the worst way: **the send happened and the message said nothing.** With no
    // `case`, an approved teacher received the generic default — while every log recorded a successful send.
    // *The promise was kept in form and broken in content.*
    //
    // 🚫 A SPECIFIC case, and NOT a general passthrough of the payload's message field — @Porter's reason is
    // better than "one more way to make a message": a general one would make every future payload's field
    // silently load-bearing, and **a field added for LOGGING becomes a message nobody meant to send.**
    // 📌 A blank falls back to the default: a poor message must never become NO message.
    case "teacher_link_approved":
      return fieldValue(payload.text) ?? t("ob_default", lang);
    // REQ-023: the daily digest travels as its check results, so it renders in each admin's own language.
    case "daily_digest":
      return buildDigestMessage((payload.checks as any[]) ?? [], lang);
    // ⛔ TASK-334 Part B — `student_registered` and `parent_asked_for_admin` still land here, and it is
    // **BLOCKED ON COPY, not an oversight.** The facts are on their payloads; the WORDS are the owner's, and
    // an admin alert is read under time pressure — the worst place to ship a string we invented. 🅿️ PARKED by
    // the owner, LIVE on the board so it is not lost.
    default:
      return t("ob_default", lang);
  }
}
