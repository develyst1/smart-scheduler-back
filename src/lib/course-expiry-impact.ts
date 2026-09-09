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
import { addDays } from "./time";

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

/**
 * 🔴 TASK-298 §5 — **what an expiry costs the family's UNUSED LEAVE**, alongside what it costs their sessions.
 *
 * `expiryImpact` answers *"which sessions fall outside?"*. It says nothing about the leave the family still
 * has — and since TASK-299 made the stored expiry the extension ceiling, **an admin can spend a course's
 * remaining quota by moving one date.** The first sign is a leave refused weeks later, with a message that
 * names the course's end date (TASK-301): honest, and still no explanation of where the room went.
 *
 * 🔑 **Numbers, not a verdict.** The wire carries how much room the date leaves and how much the family needs;
 * the sentence is the screen's, which is the same division that lets `ExpiryWarningAlert` compute nothing.
 * 🚫 **Not a gate** — REQ-082 AC-4 and §11.3 both say warn-and-save, and TASK-299's rule is that a deliberate
 * act sets the boundary. **The admin may spend the quota; they may not spend it blind.**
 *
 * ⚠️ Measured with the SAME `EXPIRY_SETTLED_STATUSES` the session impact uses, and the same inclusive boundary
 * (a date ON the expiry is inside it) — a boundary meaning one thing here and another there is worse than no
 * warning at all.
 */
export interface ExpiryLeaveRoom {
  /** Leaves the family still has. **0 ⇒ nothing to lose, and nothing to warn about.** */
  remainingLeave: number;
  /** The last session still owed — what the quota's weeks are measured FROM. `null` when none is left. */
  planEnd: string | null;
  /** The date the promise needs: `planEnd + remainingLeave` weeks. `null` when there is no plan left. */
  neededFor: string | null;
  /** How many of the remaining leaves this date leaves room for. */
  roomFor: number;
  /** 🔑 The one fact the screen turns on — and it is false only when there is something to say. */
  roomForAll: boolean;
}

export function expiryLeaveRoom(
  expiryDate: string,
  sessions: readonly ExpiryCandidate[],
  remainingLeave: number,
): ExpiryLeaveRoom {
  const owed = sessions.filter((s) => !isSettled(s.status)).map((s) => s.date);
  const planEnd = owed.length ? owed.reduce((m, d) => (d > m ? d : m)) : null;
  if (!planEnd) {
    // Nothing still owed ⇒ no make-up can be appended ⇒ the date takes nothing away.
    return { remainingLeave, planEnd: null, neededFor: null, roomFor: remainingLeave, roomForAll: true };
  }
  let roomFor = 0;
  while (roomFor < remainingLeave && addDays(planEnd, (roomFor + 1) * 7) <= expiryDate) roomFor++;
  return {
    remainingLeave,
    planEnd,
    neededFor: addDays(planEnd, remainingLeave * 7),
    roomFor,
    roomForAll: roomFor >= remainingLeave,
  };
}
