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
export const isCancel = (text: string): boolean => CANCEL.includes(text.trim().toLowerCase());

/**
 * `YYYY-MM-DD`, or `null` when skipped/unparseable.
 *
 * Deliberately strict: a birthdate that silently becomes the wrong date is worse than one nobody entered, and
 * this roster has no delete. A malformed answer re-asks rather than guessing a format.
 */
export function parseBirthDate(text: string): { ok: true; value: string | null } | { ok: false } {
  const raw = text.trim();
  if (isSkip(raw)) return { ok: true, value: null };
  const m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return { ok: false };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return { ok: false };
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // Round-trip through Date so 2026-02-31 is refused rather than silently rolled into March.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return { ok: false };
  return { ok: true, value: iso };
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
    `${labels.birthDate}: ${draft.birthDate ?? labels.none}`,
    `${labels.province}: ${draft.province ?? labels.none}`,
  ];
}
