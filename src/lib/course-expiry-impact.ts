// SPEC-076 / TASK-264 (REQ-082 AC-4 + ข) — **"is this expiry a problem, and for which sessions?"**, once.
//
// 🔴 THREE callers ask this question, and three copies of one answer is this project's most frequent defect:
// three status lists on 09-06, three parent lookups on 09-05, two labelling conventions the same day. The
// callers are the expiry EDIT's warning, the RESUME's warning, and the resume's `EXPIRY_REQUIRED` gate — and
// the last two must agree by construction, because (ข) is precisely *"the gate fires only when the warning
// does"*. Two implementations of that sentence is a gate that demands a date on a resume where nothing is
// wrong, or lets one through where something is.
//
// ✅ Pure, and it takes the sessions rather than fetching them: the resume asks about sessions that **do not
// exist yet** (the dates it is about to create), and the edit asks about rows already on the calendar. One
// function can serve both only if it never goes to the database itself.
import type { CourseStatus } from "./course-status";

/**
 * 🔴 THE THIRD STATUS LIST IN THIS PRODUCT, and — per the rule the other two are documented by — it answers a
 * question neither of them asks:
 *
 * | list | question |
 * |---|---|
 * | `SLOT_INACTIVE_STATUSES` | *does it hold a teacher's slot?* |
 * | `CALENDAR_HIDDEN_STATUSES` | *does it appear on the grid?* |
 * | **`EXPIRY_SETTLED_STATUSES`** | ***is this session already finished with, whatever the boundary says?*** |
 *
 * ⚠️ **Written as the SETTLED set, not the affected set, on purpose.** A status added tomorrow then falls into
 * "still owed" and gets WARNED about, rather than being silently dropped from the warning. Both defaults are
 * wrong in some case; this one is wrong loudly, and the other is wrong in the direction where a family loses
 * sessions nobody was told about. `PAUSED` (TASK-260) is deliberately NOT here: a paused booking keeps its date
 * and is still owed to the family, so a boundary moving in front of it is exactly what an admin needs told.
 */
export const EXPIRY_SETTLED_STATUSES = ["ATTENDED", "SICK_LEAVE", "NO_SHOW", "CANCELLED"] as const;

const isSettled = (status: string | null | undefined): boolean =>
  !!status && (EXPIRY_SETTLED_STATUSES as readonly string[]).includes(status);

/** The shape both callers can produce: a row on the calendar, or a date the resume is about to create. */
export interface ExpiryCandidate {
  /** Absent for sessions that do not exist yet — the resume asks about dates before it writes them. */
  id?: string;
  date: string;
  status?: CourseStatus | string | null;
  startTime?: string | null;
}

export interface ExpiryImpact {
  /** The expiry the question was asked about — echoed so a caller cannot report one and have decided another. */
  expiryDate: string;
  /** 🔴 The single fact (ข) turns on: does the warning fire? */
  warn: boolean;
  /** Which sessions fall outside, so the admin is told WHICH — AC-4 asks for the list, not a count. */
  outside: ExpiryCandidate[];
  outsideCount: number;
}

/**
 * Sessions that fall **outside** `expiryDate` — later than the boundary, and not already finished with.
 *
 * ⚠️ Strictly LATER: a session ON the expiry date is inside it. The expiry is the last day the course is good
 * for, which is how `voucherUsable` and `courseStatus` (`c.expiryDate < today`) already read it — a boundary
 * that means one thing in the warning and another in the status is worse than no warning.
 */
export function expiryImpact(expiryDate: string, sessions: readonly ExpiryCandidate[]): ExpiryImpact {
  const outside = sessions
    .filter((s) => !isSettled(s.status) && s.date > expiryDate)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { expiryDate, warn: outside.length > 0, outside, outsideCount: outside.length };
}
