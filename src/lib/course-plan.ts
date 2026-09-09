// SPEC-028 / TASK-092 — the course-plan reconcile ENGINE (pure). A course owes `size` teachable sessions;
// leave and insert are moves *within* that number, never changes to it. The plan is a read-projection over
// the course's bookings — this decides WHICH sessions move and HOW, and never touches the DB (the applier
// `reconcileCoursePlan` does). Direct analog of TASK-091's `planHoldMoves`: a target + moves toward it.

/** LIVE = still owed/scheduled; DELIVERED = the session happened (attended, or forfeited as NO_SHOW). */
export const COURSE_LIVE_STATUSES = ["PENDING", "CONFIRMED", "EXTENDED"] as const;
export const COURSE_LIVE = new Set<string>(COURSE_LIVE_STATUSES);
export const COURSE_DELIVERED = new Set(["ATTENDED", "NO_SHOW"]);
// SICK_LEAVE earns a replacement (neither live nor delivered); CANCELLED is out of the plan.

import { courseExpiry } from "./recurring";
import { addDays } from "./time";

export interface PlanSession {
  id: string;
  status: string;
  date: string; // "YYYY-MM-DD" — ISO, so string compare = date order
  extendedFromId: string | null;
  /** SPEC-033 §2 — the course engine counts only COURSE_PACKAGE rows. A soft-linked SINGLE_SESSION "extra" shares
   *  the courseId but must NOT count toward size/owed/end. Absent (legacy/tests) ⇒ treated as a plan row. */
  bookingType?: string;
}

/** SPEC-033 seam-keeper: is this a row the course-plan engine should count? Only COURSE_PACKAGE (absent = yes, for
 *  back-compat) — a SINGLE_SESSION extra soft-linked by courseId is deliberately excluded. */
export const isCoursePlanRow = (s: { bookingType?: string }): boolean =>
  s.bookingType === undefined || s.bookingType === "COURSE_PACKAGE";

export interface CoursePlan {
  /** Sessions to add (short course). One per owed slot; carries the absence id that opened the gap. */
  append: Array<{ extendedFromId: string | null }>;
  /** Sessions to cancel (long course) — newest appended `EXTENDED` first; never delivered/hand-placed. */
  cancelIds: string[];
}

/** Count toward the target: LIVE + DELIVERED, over COURSE_PACKAGE rows only (SPEC-033 — extras don't count). */
export function courseCurrent(sessions: PlanSession[]): number {
  return sessions.filter(
    (s) => isCoursePlanRow(s) && (COURSE_LIVE.has(s.status) || COURSE_DELIVERED.has(s.status)),
  ).length;
}

/**
 * The plan's DISPLAYED end date (SPEC-028 §4 / TASK-097) — `max(date)` over the LIVE sessions, derived on
 * every read (never the stored `expiryDate`, which is only the MAX_WEEK ceiling). `null` when nothing is live.
 */
export function deriveLiveEndDate(sessions: Array<{ status: string; date: string }>): string | null {
  const live = sessions.filter((s) => COURSE_LIVE.has(s.status)).map((s) => s.date);
  return live.length ? live.reduce((m, d) => (d > m ? d : m)) : null;
}

// ── Guards for the applier (TASK-093) — pure, so each rule is pinned independently of the DB write ──

/** A delivered session (attended, or forfeited as NO_SHOW) is immutable — can't be edited/moved. */
export const isDelivered = (status: string): boolean => COURSE_DELIVERED.has(status);

/**
 * TASK-105 (SPEC-028 §11.2) — cancelling a DELIVERED session is allowed (to undo a mis-marked attendance) but
 * ONLY with a non-empty reason, audited. Edit/move of a delivered session stays blocked (that's `isDelivered`);
 * this opens just the cancel-with-reason door. A non-delivered cancel needs no reason.
 */
export const requiresCancelReason = (status: string): boolean => isDelivered(status);

/**
 * An insert is only valid when the course has an outstanding owed session to satisfy: it's currently **short**
 * (a leave opened a gap the insert fills directly), OR there is an appended `EXTENDED` session the reconcile
 * can cancel to net-zero. Otherwise the insert would grow the course to `size + 1` — refuse instead
 * ("คอร์สนี้ครบจำนวนคาบแล้ว — ไม่มีคาบค้างให้เลื่อน", SPEC-028 §2).
 */
export function canInsert(sessions: PlanSession[], size: number): boolean {
  return (
    courseCurrent(sessions) < size ||
    sessions.some((s) => isCoursePlanRow(s) && s.status === "EXTENDED")
  );
}

/**
 * Does an appended/extended date exceed the course's HARD ceiling? The append refuses past it (SPEC-028 §5 #2
 * — a leave could otherwise extend a course indefinitely).
 *
 * 🔴 **TASK-299 — the ceiling is the course's own stored `expiryDate`, not one re-derived from the purchase
 * date.** This read `date > courseExpiry(startDate, size)`, so it **never consulted the column that
 * `courseExpiry`'s own doc calls *"only the MAX_WEEK ceiling"*** — the code did not read the column that says
 * it is the answer. One line, three faces:
 * 1. a 4-session course with three declared absences could not be CREATED — its plan ran to week 7 and the
 *    re-derived ceiling sat at week 5;
 * 2. a course resumed after a long pause was at or past its ceiling the moment it came back, because
 *    `startDate` correctly stays the PURCHASE date (TASK-282) and this measured from it;
 * 3. **an admin moved the expiry so an extra session would fit, and nothing happened at all** — which is the
 *    entire reason the owner asked for that control.
 *
 * 🔑 **The rule, and @Porter's *"what still bounds a course?"* answered: the ceiling refuses AUTOMATIC growth
 * and yields to a DELIBERATE act.** A leave-driven auto-extend still cannot pass the agreed boundary; an
 * admin editing the expiry, or a plan being drawn at creation, sets that boundary on purpose.
 * 🚫 So this is NOT a check that got skipped — `courseExpiry`, `maxWeekFor` and `MAX_WEEK_BY_SIZE` are
 * untouched and still COMPUTE the boundary a course is born with. **Only the SOURCE changed.**
 *
 * The comparison stays inclusive: a date landing exactly ON the ceiling is allowed (week 8 for a size-6 is
 * owner-confirmed and load-bearing).
 */
export function exceedsExtensionCeiling(date: string, ceiling: string): boolean {
  return date > ceiling;
}

/**
 * 🔑 **REQ-085 §10 — the ceiling a course is BORN with: the MAX_WEEK rule, STRETCHED to cover the plan the
 * admin actually drew.**
 *
 * ⚠️ **This is why §10 is not "skip the check at creation".** The course row stores
 * `courseExpiry(startDate, size)`, computed with no knowledge of the plan — so a 4-session course with three
 * declared absences was born with its plan running to week 7 and its ceiling at week 5. Deleting the gate
 * would let it be created and then refuse its FIRST post-creation leave: **a course sitting behind its own
 * last session, which is DEF-4's exact shape re-created at creation time.**
 *
 * Each declared absence earns one make-up, appended a week after the plan's last session, so the boundary a
 * drawn plan needs is `lastPlanned + absences` weeks.
 * 🔴 **TASK-301 — the arithmetic was one term short, and the owner found it on his own course.** The stretch
 * was computed from the ABSENCES alone, so a 4-session course with three of them ended at week 7 with a
 * ceiling of week 7: **the card said `Leave 0/1` and the course could not take it.** §10 had handed the admin
 * unlimited absences at creation and silently removed the one leave the family had afterwards.
 * ⇒ **The base ceiling always encoded *plan end + quota weeks*** — an absence-free size-4 ends week 4 and
 * expires week 5 — **and the stretch has to preserve that promise, not just the plan's length.**
 *
 * 🚫 **It never SHRINKS the ceiling.** A course whose plan ends early still owes the family the leave window
 * they bought, so `courseExpiry` stays the floor.
 */
export function courseBornCeiling(
  base: string,
  lastPlanned: string,
  absences: number,
  quota: number,
): string {
  // 🔑 THE PROMISE, in words, because a bare `+ 7` is a number nobody can check:
  //
  //     the ceiling is **the plan's end plus the leave quota**, in weeks.
  //
  // Each declared absence earns one make-up a week after the plan, so the PLAN ends `absences` weeks after
  // its last booked session. The quota's weeks then sit BEYOND that end — which is exactly what the base
  // ceiling already gives an absence-free course, and the term TASK-301 found missing.
  const planEnd = addDays(lastPlanned, absences * 7);
  const stretched = addDays(planEnd, quota * 7);
  return stretched > base ? stretched : base;
}

/**
 * The moves to bring a course back to `size` teachable sessions.
 * - short  (`current < size`): append `size − current` sessions, each linked to an unmatched SICK_LEAVE.
 * - long   (`current > size`): cancel the newest-dated `EXTENDED` (appended) sessions — never an
 *   attended/delivered or a hand-placed (non-`EXTENDED`) session.
 * - at target: no moves (idempotent — a date/teacher-only edit yields zero moves).
 */
export function planCourseMoves(allSessions: PlanSession[], size: number): CoursePlan {
  // SPEC-033 seam-keeper: the engine only ever moves COURSE_PACKAGE rows — a soft-linked extra is invisible here.
  const sessions = allSessions.filter(isCoursePlanRow);
  const current = courseCurrent(sessions);

  if (current === size) return { append: [], cancelIds: [] };

  if (current < size) {
    const need = size - current;
    // A leave is "matched" once some session was appended for it (extendedFromId points back to it).
    const matched = new Set(
      sessions.map((s) => s.extendedFromId).filter((x): x is string => x !== null),
    );
    const unmatchedLeaves = sessions
      .filter((s) => s.status === "SICK_LEAVE" && !matched.has(s.id))
      .sort((a, b) => a.date.localeCompare(b.date)); // oldest gap first
    const append = Array.from({ length: need }, (_, i) => ({
      extendedFromId: unmatchedLeaves[i]?.id ?? null,
    }));
    return { append, cancelIds: [] };
  }

  // long: remove the trailing appended session(s) — newest-dated LIVE EXTENDED first.
  const over = current - size;
  const cancelIds = sessions
    .filter((s) => s.status === "EXTENDED")
    .sort((a, b) => b.date.localeCompare(a.date)) // newest first
    .slice(0, over)
    .map((s) => s.id);
  return { append: [], cancelIds };
}

/**
 * SPEC-060 / TASK-165 (REQ-064) — **how many sessions this course's PLAN is responsible for.**
 *
 * An imported course was bought elsewhere and partly taught elsewhere: `size` is what the family paid for, but
 * only `size − priorSessions` sessions were ever scheduled here (import deliberately creates no rows for the
 * past ones — inventing them would put fictional attendance in the reports). Measuring that plan against `size`
 * is what made one leave produce five sessions.
 *
 * 🔴 **Two different numbers, both correct, and they must not be confused:**
 * - `size` — the PURCHASE. Leave quota, the card label and the expiry ceiling are all about what was bought,
 *   and they are already right. This function must never be used for those.
 * - `planSize` — the SCHEDULE. Only the reconciler, `owedCount` and `insertable` ask this question.
 *
 * A SALE course has `priorSessions = 0`, so `planSize === size` and nothing about today's behaviour changes.
 * That is why the field is immutable and attendance-invariant rather than derived from `usedSessions`.
 */
export const coursePlanSize = (course: { size: number; priorSessions?: number | null }): number =>
  Math.max(0, course.size - (course.priorSessions ?? 0));

/**
 * 🔴 SPEC-060 §6 — **the reconciler may not cancel an imported course's sessions to shrink it.**
 *
 * Some of the courses already live carry phantom sessions from a leave taken before this fix. Once `planSize`
 * is correct they read as "too long", and `planCourseMoves` would dutifully cancel the excess — silently
 * deleting sessions that families have been told about, as a side effect of a bug fix they never saw. Whether
 * a real child's lesson disappears from the calendar is the owner's decision, so the cancels are **withheld
 * and reported** (TASK-166), never applied.
 *
 * Scoped to imports (`priorSessions > 0`) so the normal cancel path — trimming an appended EXTENDED after a
 * leave is undone — is untouched on every SALE course. An import could not shrink before this fix either (its
 * baseline was always too big), so nothing that worked today stops working.
 */
export function withholdImportCancels(
  plan: CoursePlan,
  priorSessions: number,
): CoursePlan & { withheldCancelIds: string[] } {
  if (priorSessions <= 0 || plan.cancelIds.length === 0) {
    return { ...plan, withheldCancelIds: [] };
  }
  return { append: plan.append, cancelIds: [], withheldCancelIds: plan.cancelIds };
}

// ─────────── SPEC-064 / TASK-181 (REQ-036) — a course ENDED early ───────────
//
// 🔴 The guarantee this section exists to make is "**no make-up is ever re-owed**", not "we remembered not to
// reconcile that once". Soft-cancelling the remaining sessions is not enough on its own: `courseCurrent` then
// reads 3 against a plan size of 10, so `owedCount` says 7, `insertable` stays true, and the next staff member
// who clicks Insert has the reconciler dutifully re-owing the sessions the family just forfeited.
//
// So `endedAt` is consulted at **the same three plan-responsibility sites** REQ-064 centralised, and the answer
// is the same at all three: an ended course's plan is finished. `size` is untouched — it is what they bought.

export interface EndableCourse {
  size: number;
  priorSessions?: number | null;
  /** Set when the course was ended early. Its presence — not its value — is what closes the plan. */
  endedAt?: Date | string | null;
}

export const isCourseEnded = (c: EndableCourse): boolean => c.endedAt != null;

/**
 * SPEC-065 / TASK-198 — is this course PAUSED? Deliberately a separate predicate from `isCourseEnded`, and it
 * deliberately does **not** feed `courseOwedTarget`: a paused course still owes its sessions — that is the
 * whole difference from an ended one. Resume gives them back; ending never does.
 */
export const isCourseDropped = (c: { droppedAt?: Date | string | null }): boolean => c.droppedAt != null;

/**
 * SPEC-065 / TASK-290 — the note `dropCourse` stamps on every session a pause cancels, and **the only thing
 * that tells those rows apart from a session an admin cancelled by hand.**
 *
 * 🔴 It is a named constant because it is now COMPARED as well as written: `toSessionRow` derives
 * `cancelledByPause` from it. **Two inline copies of one Thai sentence, in one file, checked against each
 * other, is the drift this field exists to prevent — one layer down.**
 * 📌 It was here before, deleted with TASK-282 §5's withdrawn design: correct then, because nothing read
 * it. Something reads it now.
 *
 * 🚫 **The sentence itself never crosses the wire** (TASK-290 §2, @Fern's ruling): the client would then
 * hold a second copy of a UI-language literal in another repo, and **a string comparison across the wire is
 * no safer than the date heuristic we just removed.** The client gets a fact; the Thai stays here.
 */
export const COURSE_PAUSE_NOTE = "พักคอร์สชั่วคราว";

/**
 * 🔑 Was this session cancelled BY A PAUSE, as opposed to by a person?
 *
 * **The distinction is the whole point of the field.** A hand-cancelled session is a decision somebody took
 * about the plan; a pause-cancelled one is the plan being replaced. That is why the plan view does not simply
 * hide every `CANCELLED` row — it would hide the first kind along with the second.
 *
 * ⚠️ **Tests for ONE value, deliberately.** Three other paths leave a `CANCELLED` row carrying text — the
 * reconciler trimming an appended make-up, an early course ending, and a hand cancel with the admin's own
 * reason. **Widening this to `note !== null` would fold all three into "paused" and the field would start
 * lying.** If a second pause-like sentence is ever needed, add a value to a list here; do not loosen the test.
 */
export const isCancelledByPause = (b: { status: string; note?: string | null }): boolean =>
  b.status === "CANCELLED" && b.note === COURSE_PAUSE_NOTE;

/** An ended course owes nothing; otherwise the plan size is REQ-064's `size − priorSessions`. */
export const courseOwedTarget = (c: EndableCourse): number =>
  isCourseEnded(c) ? 0 : coursePlanSize(c);

/**
 * May a session be inserted into this course? Never, once it has ended — an insert is a *reschedule* of an
 * owed session, and an ended course owes none. Guarded ahead of `canInsert` rather than inside it, because the
 * pure predicate answers a different question ("is anything outstanding?") that stays true of the leftovers.
 */
export const canInsertIntoCourse = (c: EndableCourse, sessions: PlanSession[]): boolean =>
  !isCourseEnded(c) && canInsert(sessions, coursePlanSize(c));

/**
 * The moves for a course, with the ended case answered first: **none**. Not "cancel the rest" — the ending
 * already did that in its own transaction, and having the reconciler cancel things afterwards would let a
 * later leave or edit reach back into a finished course.
 */
export function planCourseMovesForCourse(c: EndableCourse, sessions: PlanSession[]): CoursePlan {
  if (isCourseEnded(c)) return { append: [], cancelIds: [] };
  return planCourseMoves(sessions, coursePlanSize(c));
}

/** SPEC-064 / TASK-181 — the closed set of reasons a course may be ended early. Closed so an `ADMIN_ERROR`
 *  course is findable later with one query; that findability is the entire reason the enum exists, since the
 *  money follow-up is a human decision taken elsewhere. */
export const END_REASONS = ["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR"] as const;
export type EndReason = (typeof END_REASONS)[number];
export const isEndReason = (v: unknown): v is EndReason =>
  typeof v === "string" && (END_REASONS as readonly string[]).includes(v);

/**
 * Which of a course's sessions an early ending removes: **everything still LIVE**.
 *
 * 🔴 The set is `COURSE_LIVE_STATUSES` itself, not a second list — PENDING, CONFIRMED **and EXTENDED**. I first
 * wrote PENDING+CONFIRMED and Sober caught the gap: an appended `EXTENDED` is a real future make-up booking on
 * a teacher's calendar, it is not slot-non-blocking, and `getCalendar` hides only CANCELLED — so **every course
 * that has ever taken a sick leave carries one.** Ending the course while leaving it behind would strand a
 * ghost session holding a slot: the same bug one label over, on the commonest path there is.
 *
 * Reusing `COURSE_LIVE_STATUSES` is the point. "Still live" is already defined for this codebase, and a
 * hand-written copy here is exactly what would drift the next time a status is added.
 *
 * Everything delivered stays byte-identical: `ATTENDED`, `NO_SHOW`, `SICK_LEAVE`, and anything already
 * `CANCELLED`. Ending a course forfeits what has not happened; it never rewrites what did — including the leave
 * that earned the make-up we are now cancelling.
 */
export const ENDABLE_STATUSES = COURSE_LIVE_STATUSES;

export const endableSessions = <T extends { status: string; bookingType?: string }>(sessions: T[]): T[] =>
  sessions.filter((s) => isCoursePlanRow(s) && COURSE_LIVE.has(s.status));

/**
 * 🔴 TASK-284 (REQ-085 §3) — **the COURSE's note: the first NON-EMPTY one, in date order.**
 *
 * 🔻 The payload read `rows[0]?.attendeeNote` — the EARLIEST session's note — and I recorded that as a known
 * limitation in TASK-269 §2 and chose not to fix it. The owner then put a note on a session that was not the
 * earliest, confirmed the course, and `CONFIRMED SCHEDULE` printed no `Remark` at all.
 * **The record was accurate and the decision was wrong**: I optimised for not inventing an answer and
 * shipped a field that renders nothing on the path a human actually takes.
 *
 * 🔑 The difference from `rows[0]` is small and it is the whole defect: `rows[0]` answers *"the earliest
 * session's note"*; this answers *"the course's note, if it has one"* — **and only the second is what a
 * reader of `CONFIRMED SCHEDULE` would take it to mean.**
 *
 * ✅ On the normal path the two are identical: TASK-178 puts one note at creation onto EVERY session.
 * ⚠️ When a course carries DIFFERENT notes it returns the earliest. 🚫 Not several, not joined, no
 * "and 2 more": **a course summary has no true answer to "which session's note", and the earliest is at
 * least a RULE rather than an accident.**
 * 📌 Date order is the CALLER's guarantee — `loadCourseForEnd` orders `asc(date), asc(startTime)`. Passing
 * unordered rows would make "earliest" mean "whichever the database returned first".
 */
export const courseNote = (sessions: Array<{ attendeeNote?: string | null }>): string | null =>
  sessions.find((s) => s.attendeeNote?.trim())?.attendeeNote ?? null;

/**
 * SPEC-065 / TASK-282 §7.1(2) — **the expiry a RE-PLAN produces.** An OUTPUT, never a request.
 *
 * 🔴 This is the fix for DEF-4, and the reason is structural rather than a tightening: that
 * validator checks the REQUEST, and a re-plan moves the last session **by construction** — so a
 * request-checking validator would wave through every resume it was written to catch. ⇒ **stop asking.**
 *
 * 🔑 It **grows, never shrinks** (owner: *วันหมดอายุก็งอกไปสิ*). A re-plan that happens to finish
 * BEFORE the current expiry leaves it alone: shrinking it would take back a window the family already had,
 * as a side effect of an admin rescheduling — which nobody asked for and nobody would be told about.
 * 📌 `null` when the re-plan lays out nothing (a course that owes zero): there is no last session to
 * cover, so there is nothing to move.
 *
 * 🔴 **TASK-302 — it must reach past the last session by the REMAINING quota, not stop on it.**
 * This returned `lastSession` exactly, and TASK-299 then made that value the extension ceiling ⇒ **a resumed
 * course had ZERO headroom and its next leave was refused.** A pause of a few weeks almost always ends later
 * than the original expiry, so this fired on the ordinary path: **the family paused, came back, and lost the
 * leave they had not used.** 🔑 TASK-301's defect, one verb over.
 *
 * ⚠️ **REMAINING, not full.** A course that has spent its quota gets no headroom, and that is correct — it
 * has no leave left to take. **That is what keeps this a promise rather than a gift.**
 * ✅ **Same arithmetic as `courseBornCeiling`, deliberately reused rather than restated:** a re-plan has no
 * declared absences, so it is that function with `absences = 0`. 🚫 **Two arithmetics for one sentence is the
 * class this whole week has been about.**
 */
export const replanExpiry = (
  currentExpiry: string,
  lastSession: string | null,
  remainingQuota: number,
): string =>
  lastSession ? courseBornCeiling(currentExpiry, lastSession, 0, remainingQuota) : currentExpiry;

