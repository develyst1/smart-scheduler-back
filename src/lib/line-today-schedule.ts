// SPEC-072 / TASK-256 (REQ-077 Parent 2 · Decision 6) — `TODAY'S SCHEDULE`: one message per person, the
// customer's block repeated per class under a shared header.
//
// 📌 The shape is @Porter's Decision 6 and his reason is the whole design: *"eight full blocks is fifty-odd lines
// on a phone, and every one of them repeats the date and the coach; a compact list loses their labels. ⇒ Neither.
// Take the constant fields out of the repeat."* One class renders **exactly as the customer's template**, which
// is the common case and the one they wrote it for.
//
// 🔴 **The correction this file exists to carry:** Decision 6 says *"`Date` and `Coach` are constant for the whole
// message"*. `Date` is — the message is one day by construction. **`Coach` is not.** A parent with two children,
// or one child in two programmes, can have two coaches in a day; and REQ-078 lets one booking carry several
// teachers, so even a coach's own copy can hold blocks with different lists. Hoisting a coach who does not teach
// every class would print **one coach's name above another coach's class** — in the message a parent reads to
// know who is teaching their child, that is not a layout wrinkle, it is a false statement.
//
// ⇒ **Hoist a field only when it is ACTUALLY constant across the blocks — computed, not assumed.** One rule, no
// parent/teacher special case: **hoisting is a property of the DATA, not of the audience**, which is exactly why
// the coach's eight-class message still hoists. @Porter's *"two formats for one message is how they drift apart"*
// is preserved rather than traded away.
//
// Pure — no DB, no clock.
import { t, type Lang } from "./line-i18n";
import { TEMPLATE_LANG } from "./line-message-fields";
import {
  fieldLines,
  notifyTypeOf,
  programLabel,
  visibleFields,
  type Audience,
  type FieldFacts,
  type FieldKey,
} from "./line-message-fields";

/** One class, as the reminder payload carries it. Every field optional but `startTime`: a deleted course, an
 *  อื่นๆ with no student, or a booking whose program was cleared must all still render. */
export interface TodayRow {
  date: string;
  startTime: string;
  endTime?: string | null;
  studentName?: string | null;
  subjectName?: string | null;
  /** An อื่นๆ booking's typed title — what names it when there is no student and no program (REQ-078). */
  title?: string | null;
  bookingType?: string | null;
  /** Purchased size (course) or total hours (voucher) — feeds `Program`, e.g. `… 6 HR`. */
  size?: number | null;
  /** Already rendered by the caller from the balance it read: `4 HR` · `4/6 ครั้ง`. */
  remaining?: string | null;
  expiryDate?: string | null;
  /** Every assigned teacher, joined — REQ-078 allows several. */
  coach?: string | null;
  /** 🔴 REQ-085 §7.2 (TASK-304) — this entry's own `Remark`, or nothing. Per BOOKING. */
  attendeeNote?: string | null;
}

/** Fields that MAY move to the header. `date` is constant by construction; `coach` only when the data agrees. */
const HOISTABLE: readonly FieldKey[] = ["date", "coach"];

const dash = (v: string | null | undefined) => (v && String(v).trim() ? String(v) : undefined);

/**
 * REQ-077 Parent 2. One class ⇒ the customer's template, verbatim. Several ⇒ Decision 6's numbered blocks under
 * whatever header the data actually supports.
 */
/**
 * 🔑 REQ-085 §7.2 (TASK-304) — the `Remark` line for ONE entry, or nothing.
 *
 * The `*ถ้ามี` rule, identical to the one §7.1 and §7.3 use — 🚫 **not a third copy of it, and never `(-)`**:
 * that placeholder belongs only to §7.1's `**Advance Leave Notice`, and this is the third message in a row
 * where the risk was carrying a rule across rather than forgetting one.
 * 📌 Per BOOKING: the customer's own example shows two entries with DIFFERENT remarks, so a per-message note
 * would be visibly wrong.
 */
const remarkLine = (r?: TodayRow): string[] =>
  r?.attendeeNote?.trim() ? [`${t("ob_f_note", TEMPLATE_LANG)} : ${r.attendeeNote.trim()}`] : [];

export function renderTodaySchedule(rows: TodayRow[], lang: Lang, audience: Audience = "parent"): string {
  const title = t("ob_today_title", lang);
  if (!rows.length) return `${title}\n${t("tsched_empty", lang)}`;

  // A day is read in time order regardless of how the query returned it (`renderSchedule`'s rule, kept).
  const ordered = [...rows].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const blocks = ordered.map((r) => {
    const type = notifyTypeOf(r.bookingType);
    return {
      type,
      fields: visibleFields("todays_schedule", type, audience),
      facts: <FieldFacts>{
        student: dash(r.studentName) ?? dash(r.title),
        program: programLabel(type, { subject: r.subjectName, size: r.size, title: r.title }),
        date: dash(r.date),
        time: r.endTime ? `${r.startTime}-${r.endTime}` : r.startTime,
        coach: dash(r.coach),
        remaining: dash(r.remaining),
        expiry: dash(r.expiryDate),
      },
    };
  });

  // 🔴 ONE class: the customer's template exactly, in their field order, with nothing hoisted and no numbering.
  // Their common case must be untouched by a layout that exists for the uncommon one.
  if (blocks.length === 1) {
    const b = blocks[0]!;
    // 🔴 TASK-304 — AUTO gains `Remark` and NOTHING else: *"Format แจ้งเตือน Auto โอเคแล้วค่ะ"*. Its
    // language, layout and field order are untouched; one field is added to each entry.
    return [title, ...fieldLines(b.fields, b.facts, lang), ...remarkLine(ordered[0])].join("\n");
  }

  // Otherwise: hoist a field only when EVERY block agrees on it — and only when every block would have printed
  // it at all, so a header can never announce a value some block was entitled to omit.
  const hoisted = HOISTABLE.filter((f) => {
    const first = blocks[0]!.facts[f];
    if (!first) return false;
    return blocks.every((b) => b.fields.includes(f) && b.facts[f] === first);
  });

  const header = fieldLines(hoisted, blocks[0]!.facts, lang);
  const body = blocks.map((b, i) => {
    // `Time` leads each block: it is what a coach scans for, and it is the field that always differs.
    const rest = b.fields.filter((f) => f !== "time" && !hoisted.includes(f));
    const [head, ...tail] = fieldLines(["time", ...rest], b.facts, lang);
    // TASK-304 — indented with its siblings, so the numbered block's shape does not move.
    const remark = remarkLine(ordered[i]).map((l) => `   ${l}`);
    // The customer's labels, indented under the number so the blocks read as a list rather than a wall.
    return [`${i + 1}) ${head}`, ...tail.map((l) => `   ${l}`), ...remark].join("\n");
  });

  return [title, ...header, "", body.join("\n\n")].join("\n");
}
