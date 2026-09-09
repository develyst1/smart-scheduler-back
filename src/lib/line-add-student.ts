// SPEC-071 / TASK-233 (REQ-079 §5 Flow 3) — เพิ่มนักเรียน: summary before write, nothing partial.
//
// 🔴 The three rules this file exists to make true, all of them pure so they are testable without a chat:
//
//  1. **The summary-and-confirm step is not optional.** This writes into a roster that has **no delete for
//     anything with history** — that is the product, not an oversight. Three seconds of review against a record
//     nobody can remove is cheap.
//  2. **A duplicate name asks for MORE DETAIL; it never demands a rename.** Two real children can share a name.
//     Telling a parent to rename their child is wrong — *and* it confirms to whoever typed it that such a child
//     exists. Asking for a surname or nickname gets the same outcome with no false claim and no leak.
//     ⚠️ This is @Porter's recommendation, not the owner's literal words (*"บอกให้ตั้งใหม่"*). If the owner
//     overrules it, only the message and AC-9 change — the machine below does not.
//  3. **Abandon halfway ⇒ nothing is written.** The draft lives on the session; the row is created at CONFIRM.
//
// Pure — no DB, no clock, no i18n side effects.

export type AddStudentStep =
  | "AWAIT_STUDENT_NAME"
  | "AWAIT_STUDENT_DETAIL"
  | "AWAIT_STUDENT_BIRTHDATE"
  | "AWAIT_STUDENT_PROVINCE"
  | "AWAIT_STUDENT_CONFIRM";

/** Every step the wizard owns, so the router and the handler cannot disagree about what "in this flow" means. */
export const ADD_STUDENT_STEPS: readonly AddStudentStep[] = [
  "AWAIT_STUDENT_NAME",
  "AWAIT_STUDENT_DETAIL",
  "AWAIT_STUDENT_BIRTHDATE",
  "AWAIT_STUDENT_PROVINCE",
  "AWAIT_STUDENT_CONFIRM",
];

export const isAddStudentStep = (step: string | null | undefined): step is AddStudentStep =>
  !!step && (ADD_STUDENT_STEPS as readonly string[]).includes(step);

/** What has been collected so far. Nothing here has touched the roster. */
export interface StudentDraft {
  name?: string;
  birthDate?: string | null;
  province?: string | null;
}

/** Words that mean "I don't want to answer this one" — the existing skip vocabulary, reused deliberately. */
export const SKIP = ["ข้าม", "ไม่", "ไม่มี", "skip", "-", "none"];
export const isSkip = (text: string): boolean => SKIP.includes(text.trim().toLowerCase());

const CONFIRM = ["ยืนยัน", "ตกลง", "ใช่", "confirm", "yes", "ok"];
const CANCEL = ["ยกเลิก", "ไม่", "cancel", "no"];
export const isConfirm = (text: string): boolean => CONFIRM.includes(text.trim().toLowerCase());

/**
 * 🔴 TASK-312 §1 (REQ-085 §13) — the inline add-a-student command, parsed by ONE rule instead of a bare prefix.
 *
 * ## The defect this closes
 * The router matched `/^(?:เพิ่มนักเรียน|เพิ่มลูก|add)\s*(.*)$/i` — **`add` was a bare prefix, `\s*` matched
 * EMPTY, and `(.*)` took the rest of the WORD.** ⇒ `admin` created a child named `in`; `address` created `ress`;
 * and `Add Student` — the phrase our own screen 8 tells a parent to type — created a child named `Student`.
 * ⚠️ None of those names is reserved, there is no delete route and no archive flag: **every one was permanent.**
 * 🔑 TASK-245's defect returned: *the bot advertises a word and swallows part of it as data.*
 *
 * ## The rule — the PATTERN is fixed, not its position in the router
 * · **English: `add` is a command only when the input ENDS there or a SEPARATOR follows.** `add` · `add Emily`.
 *   `admin` and `address` no longer match and fall through to their real handlers.
 * · **`Add Student` is the COMMAND, not `add` + a name** — case-insensitive and space-collapsed (`§13.3`):
 *   🔑 TASK-313 §5 — and so is **`add child`**, OUR older English phrase: no longer advertised, still accepted, and
 *   when typed it ADDS a child rather than naming one `child` (@Porter, verbatim). One shape, three phrases.
 *   `Add Student` · `add student` · `AdD StUdEnT` · `addstudent`. All start the name prompt; none writes.
 * · 📌 **Decision, written down because the customer's screen only promises the bare phrase:**
 *   `Add Student Emily` creates **`Emily`**. The phrase is the command, and it takes a name after a separator
 *   exactly as the bare `add` does — ONE shape, and it can never write `Student Emily` as a name.
 *   `addstudentemily` (no separator) matches nothing and writes nothing.
 * · **Thai keeps its tolerance**: `เพิ่มนักเรียนน้องเอ` still reads `น้องเอ`. Thai is written without spaces and
 *   no other Thai command begins with `เพิ่มนักเรียน`, so the ambiguity that broke `add` does not exist there.
 *
 * Returns `null` for "not this command", otherwise the name — `null` when the command was bare.
 */
export function parseAddCommand(text: string): { name: string | null } | null {
  const raw = text.trim();
  const thai = raw.match(/^(?:เพิ่มนักเรียน|เพิ่มลูก)\s*(.*)$/);
  if (thai) return { name: thai[1].trim() || null };
  const en = raw.match(/^add(?:\s*(?:student|child))?(?:\s+(.+))?$/i);
  if (en) return { name: (en[1] ?? "").trim() || null };
  return null;
}
export const isCancel = (text: string): boolean => CANCEL.includes(text.trim().toLowerCase());

/**
 * The owner's format, `วัน-เดือน-ปี` (**`DD-MM-YYYY`**) in, **`YYYY-MM-DD` out** — the STORED value is
 * unchanged, because this is an input format and not a storage format. `null` when skipped.
 *
 * ## 🔴 TASK-277 (REQ-079 §17, closed by the owner 2026-09-06)
 * This matched **four-digit-year-first and nothing else** — the format the owner overruled. The customer
 * asked for day-first; the owner took their ORDER with our DASH.
 *
 * ## ⚠️ The four-digit-first string is REFUSED, not reinterpreted — §17's own warning
 * *"The bot must still accept a 4-digit-first string and refuse it CLEARLY rather than read `2024-12-02`
 * as day 2024 and produce a confusing error."* ⇒ that shape is recognised and rejected, so the parent gets
 * the format sentence instead of *"day 2024 is not a day"*.
 * 🚫 **Both orders are NOT accepted.** If they were, `03-04-2024` would mean two different dates depending
 * on which rule fired — and there is no way for a reader to tell which one they got.
 *
 * ⚠️ `03-04-2024` is still genuinely ambiguous to a HUMAN — 3 April or 4 March. **What saves it is the
 * confirm step**, which prints the date back before anything is written. §17's words: that step is now
 * **load-bearing for correctness**, not merely for review.
 *
 * Deliberately strict otherwise: a birthdate that silently becomes the wrong date is worse than one nobody
 * entered, and this roster has no delete. A malformed answer re-asks rather than guessing a format.
 */
export function parseBirthDate(text: string): { ok: true; value: string | null } | { ok: false } {
  const raw = text.trim();
  if (isSkip(raw)) return { ok: true, value: null };
  // 🔴 The retired order, caught FIRST and refused. Falling through to the day-first pattern below would
  // read `2024-12-02` as day 2024 — which fails anyway, but with an error about a day rather than a format.
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(raw)) return { ok: false };
  const m = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!m) return { ok: false };
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return { ok: false };
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // Round-trip through Date so 2026-02-31 is refused rather than silently rolled into March.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return { ok: false };
  return { ok: true, value: iso };
}

/**
 * 🔴 TASK-280 — the stored ISO date, shown back in the order the parent TYPED it: `2024-12-02` →
 * `02-12-2024`.
 *
 * ## Why this is not cosmetic
 * TASK-277 made the confirm step **load-bearing for correctness** because `03-04-2024` is ambiguous to a
 * HUMAN — 3 April or 4 March. The parser is unambiguous; the person is not, and the summary exists to let
 * them catch their own slip. ⇒ **echoing in the other order makes the reader perform exactly the conversion
 * the step exists to spare them.** On this field that is close to no guard at all.
 *
 * ## 🚫 It is deliberately NOT the inverse of `parseBirthDate`, and must never be used as one
 * The obvious future mistake is reaching for it to undo the parse. **The stored value stays ISO** — a
 * display format reaching the database is the one way this can do harm — and its only caller is
 * `summaryLines`, asserted by position rather than by a count so a fourth call site cannot slip past.
 *
 * ⚠️ A value that is not a well-formed ISO date **passes through unchanged**. Same rule as the phone
 * formatter: the display must not invent a shape for something it does not recognise.
 */
export function formatBirthDateForDisplay(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}
/**
 * 🔴 AC-9 — what to do when the name already exists in THIS family.
 *
 * `more-detail`, never `rename`. The distinction is the requirement: a rename demand is both wrong (two real
 * children can share a name) and a disclosure (it confirms such a child exists to whoever typed the phone).
 */
export type DuplicateOutcome = "ok" | "more-detail";
export const decideDuplicate = (existingNames: string[], name: string): DuplicateOutcome =>
  existingNames.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase()) ? "more-detail" : "ok";

/** The next step after each answer. One place, so no branch can skip the confirm. */
export function nextStep(current: AddStudentStep, outcome: DuplicateOutcome = "ok"): AddStudentStep {
  switch (current) {
    case "AWAIT_STUDENT_NAME":
      return outcome === "more-detail" ? "AWAIT_STUDENT_DETAIL" : "AWAIT_STUDENT_BIRTHDATE";
    case "AWAIT_STUDENT_DETAIL":
      return "AWAIT_STUDENT_BIRTHDATE";
    case "AWAIT_STUDENT_BIRTHDATE":
      return "AWAIT_STUDENT_PROVINCE";
    case "AWAIT_STUDENT_PROVINCE":
      return "AWAIT_STUDENT_CONFIRM";
    case "AWAIT_STUDENT_CONFIRM":
      return "AWAIT_STUDENT_CONFIRM";
  }
}

/**
 * 🔴 The summary a parent confirms. It shows exactly the three things that will be written, and **a field the
 * parent skipped is shown as skipped rather than omitted** — an absent line reads as "the system already knows
 * that", which is the misunderstanding a confirmation step exists to prevent.
 *
 * Labels are passed in by the caller so this stays pure and the copy stays in `line-i18n`.
 */
export function summaryLines(
  draft: StudentDraft,
  labels: { name: string; birthDate: string; province: string; none: string },
): string[] {
  return [
    `${labels.name}: ${draft.name ?? labels.none}`,
    // 🔴 TASK-280 — shown in the order the parent typed (`DD-MM-YYYY`), not the ISO we store. This line IS
    // the guard TASK-277 leans on; printing it back in the other order made the reader do the conversion.
    `${labels.birthDate}: ${draft.birthDate ? formatBirthDateForDisplay(draft.birthDate) : labels.none}`,
    `${labels.province}: ${draft.province ?? labels.none}`,
  ];
}
