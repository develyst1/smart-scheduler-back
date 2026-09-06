// SPEC-072 / TASK-253 (REQ-077) — **the one table-shaped place**: which fields a notification renders, for
// which booking type, to which audience.
//
// 🔴 Why it is a table and not a switch. Every per-type rule here is one of @Porter's five decisions, each of
// them **labelled reversible and not yet reviewed by the customer**. *A decision that costs a rewrite to reverse
// was not really reversible* — so each is one line, in one file, and reverting it is deleting or flipping that
// line rather than re-reading a renderer.
//
// 🔑 And the audience is a PROJECTION, never a second payload. `scheduler.service.ts` builds one payload for the
// parent and the teacher on purpose (*"one of them would be missed, which is how the parent ends up reading a
// different schedule from the teacher"*). The facts stay one object; this decides what each person sees of it.
//
// Pure — no DB, no clock. It touches i18n only for the customer's own field labels.
import { t, type Lang } from "./line-i18n";

/** The five types the REQ's per-type table is written in, independent of the DB enum's spelling. */
export type NotifyType = "COURSE" | "VOUCHER" | "ONE_HOUR" | "FIRST_TRIAL" | "OTHER";

export type Audience = "parent" | "teacher";

/** The three templates that carry a field block (REQ-077 "THE TEMPLATES — final, for build"). */
export type TemplateKey = "confirmed_schedule" | "todays_schedule" | "course_deduction";

export type FieldKey =
  | "student"
  | "program"
  | "date"
  | "time"
  | "start"
  | "coach"
  | "remaining"
  | "expiry"
  | "advanceLeave";

/** The DB's `booking_type` in the REQ's vocabulary. One mapping, so no caller invents a second one. */
export function notifyTypeOf(bookingType: string | null | undefined): NotifyType {
  switch (bookingType) {
    case "COURSE_PACKAGE":
      return "COURSE";
    case "VOUCHER":
      return "VOUCHER";
    case "FIRST_TRIAL":
      return "FIRST_TRIAL";
    case "OTHER":
      return "OTHER";
    // `SINGLE_SESSION` is what the customer calls 1HR — and the fallback, because a type nobody has taught this
    // table about must render the SMALLEST message, never one that invents a balance it cannot know.
    default:
      return "ONE_HOUR";
  }
}

/** Template order — the customer's own line order, so a rendered message can be diffed against their draft. */
export const TEMPLATE_FIELDS: Record<TemplateKey, readonly FieldKey[]> = {
  // Parent 1 · CONFIRMED SCHEDULE — the only one with `Start` (@Porter's decision 1: a course has a first day;
  // a single session IS its date, so the line would repeat itself).
  confirmed_schedule: ["student", "program", "date", "time", "start", "coach", "expiry", "advanceLeave"],
  // Parent 2 · TODAY'S SCHEDULE
  todays_schedule: ["student", "program", "date", "time", "coach", "remaining", "expiry"],
  // Parent 3 · COURSE DEDUCTION (TASK-254) — `remaining` here is the balance AFTER the deduction.
  course_deduction: ["student", "program", "date", "time", "coach", "remaining", "expiry"],
};

/**
 * 🔴 Per-type omissions — REQ-077's own table, one line each.
 *
 * A 1HR, a 1st Trial and an อื่นๆ have **no balance and no expiry to speak of**, and printing an empty or a
 * zero would state something false about money.
 */
export const TYPE_OMITS: Record<NotifyType, readonly FieldKey[]> = {
  COURSE: [],
  VOUCHER: [],
  ONE_HOUR: ["remaining", "expiry"],
  FIRST_TRIAL: ["remaining", "expiry"],
  OTHER: ["remaining", "expiry"],
};

/**
 * 🔴 The audience projection — @Porter's call, flagged for the customer's review.
 *
 * *"A course's expiry and a family's declared absences are the FAMILY's business."* A coach needs who · what ·
 * when · and where they stand today. ⚠️ The customer's own draft had both lines on the teacher's copy,
 * byte-identical to the parent's — **which is exactly what copy-paste looks like**. If they meant it, this is
 * the one line to put back.
 * 📌 `coach` is deliberately KEPT for the teacher: someone covering a class needs to see whose class it is.
 */
export const AUDIENCE_OMITS: Record<Audience, readonly FieldKey[]> = {
  parent: [],
  teacher: ["expiry", "advanceLeave"],
};

/**
 * The fields this message shows, in template order, after both omission lists.
 *
 * Everything above is data, so this is the whole rule: order from the template, minus what the type has none of,
 * minus what this audience is not shown.
 */
export function visibleFields(template: TemplateKey, type: NotifyType, audience: Audience): FieldKey[] {
  const omitted = new Set<FieldKey>([...TYPE_OMITS[type], ...AUDIENCE_OMITS[audience]]);
  return TEMPLATE_FIELDS[template].filter((f) => !omitted.has(f));
}

/**
 * `Program` per type — REQ-077's table, again as data.
 *
 * 📌 An อื่นๆ booking's programme is **the title the admin typed**: it has no subject, and being asked to type a
 * real name is the entire point of that field (REQ-078). Returns `undefined` when there is nothing true to say,
 * so the caller's existing omit-empty rule applies and no blank label is printed.
 */
export function programLabel(
  type: NotifyType,
  facts: { subject?: string | null; size?: number | null; title?: string | null },
): string | undefined {
  const subject = facts.subject?.trim() || undefined;
  switch (type) {
    case "COURSE":
      // e.g. `Private Freeskate 6 HR` — the package as the customer writes it.
      return subject && facts.size ? `${subject} ${facts.size} HR` : subject;
    case "VOUCHER":
      return subject;
    case "ONE_HOUR":
      return subject ? `${subject} 1 HR` : undefined;
    case "FIRST_TRIAL":
      return subject ? `${subject} 1st Trial` : undefined;
    case "OTHER":
      return facts.title?.trim() || undefined;
  }
}

/** The facts a template block may draw on. ONE object per message — the audience picks from it, never a second. */
export interface FieldFacts {
  student?: string;
  program?: string;
  date?: string;
  time?: string;
  start?: string;
  coach?: string;
  remaining?: string;
  expiry?: string;
  advanceLeave?: string;
}

const FIELD_LABEL: Record<FieldKey, string> = {
  student: "ob_f_student",
  program: "ob_f_program",
  date: "ob_f_date",
  time: "ob_f_time",
  start: "ob_f_start",
  coach: "ob_f_coach",
  remaining: "ob_f_remaining",
  expiry: "ob_f_expiry",
  advanceLeave: "ob_f_advance_leave",
};

/**
 * SPEC-072 / TASK-253 — REQ-077's field block: template order, minus what this type has none of, minus what
 * this audience is not shown. The whole decision lives in `line-message-fields.ts`; this is only the printing.
 *
 * ⚠️ **`**Advance Leave Notice` must never reach the omit-empty rule.** Its caller resolves it to the literal
 * `ไม่มี` **before** it arrives, so it is never an empty value — @Porter's reason, and it is the point of the
 * field: *a parent may be reading the message TO CHECK that, and silence cannot be told from a missing feature.*
 * Every other field keeps the existing rule (TASK-219: a blank label reads as information that went missing).
 */

export function fieldLines(fields: FieldKey[], facts: FieldFacts, lang: Lang): string[] {
  // The customer's separator is ` : `, not `: ` — theirs, so a rendered message can be diffed against their
  // own draft without an eye for whitespace. Returned as LINES so a composer can indent them (TASK-256).
  return fields.map((f) => (facts[f] ? t(FIELD_LABEL[f], lang) + " : " + facts[f] : "")).filter(Boolean);
}

export function renderFieldBlock(
  template: TemplateKey,
  facts: FieldFacts,
  opts: { type: NotifyType; audience: Audience; lang: Lang },
): string {
  return fieldLines(visibleFields(template, opts.type, opts.audience), facts, opts.lang)
    .map((l) => `${l}\n`)
    .join("");
}
