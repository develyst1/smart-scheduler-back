// TASK-570 (REQ-110 item 6) — move a NOT-YET-STARTED course's start date, the expiry recomputed the normal way. THE PLAN, pure
// apart from the ONE injected question "is this teacher on an advance leave that day?" (TASK-561's reader, passed in — never a
// second definition). The service applies what this returns; nothing here writes.
//
// Khwan's reason for the feature is the money: the workaround (cancel the course, create a new one) "จะทำให้เงินงง". So the
// plan MOVES the sessions the course already has — the same rows, re-dated — and creates and cancels nothing:
//   · no new row ⇒ every link a row carries (a make-up's `extendedFromId`, TASK-553) travels with it — this is NOT a fourth
//     writer that could answer a leave unlinked; it answers nothing new;
//   · the sale, the rows' ids, rentals and rates are the same objects, only their dates change.
import { courseBornCeiling, isCoursePlanRow, isDelivered } from "./course-plan";
import { courseExpiry } from "./recurring";
import { addDays } from "./time";

export interface StartChangeRow { id: string; date: string; status: string; teacherId: string; extendedFromId: string | null; plannedAtCreation?: boolean | null; bookingType?: string }
export interface StartChangeCourse { startDate: string; size: number; expiryDate: string; priorSessions?: number | null }
export type StartChangeRefusal = { code: "START_IN_PAST" | "COURSE_STARTED" | "NOTHING_TO_MOVE"; message: string };
export interface StartChangePlan {
  moves: Array<{ id: string; teacherId: string; from: string; to: string; status: string; toStatus: string }>;
  /** Apply in THIS order: a shift later moves the last row first, so no row lands on a sibling's date before it has left. */
  order: string[];
  expiryDate: string;
  /**
   * 🔴 TASK-578 (D9) — HOW MANY sessions were CONFIRMED and return to PENDING (their confirmation was of the OLD schedule) ⇒ the
   * admin re-confirms: ONE message. A COUNT, not a flag: the page prints it ("4 คาบต้องยืนยันใหม่") — a boolean printed "true".
   * `0` = nothing to re-confirm.
   */
  needsReconfirm: number;
  /** Weeks passed over because the row's teacher is on an advance leave (TASK-561 — the make-up's SKIP rule). */
  skipped: Array<{ teacherId: string; date: string }>;
}

/**
 * 🔑 "NOT YET STARTED", exactly: nothing was imported as already taught (`priorSessions` = 0), and EVERY row of the plan that
 * is not CANCELLED is dated today or later (none delivered, no leave in the past). A CANCELLED row does not start a course —
 * the family attended nothing and nothing was charged — so a course whose first session was cancelled is still movable.
 * 🚫 Not "the start date is in the future" alone: that misses a course whose first session happened; not "no attended
 * session" alone: that treats a past no-show or a past leave as not started, and both have already run the course's time.
 */
export function courseNotStarted(course: StartChangeCourse, rows: StartChangeRow[], today: string): boolean {
  if ((course.priorSessions ?? 0) > 0) return false;
  return rows.filter(isCoursePlanRow).filter((r) => r.status !== "CANCELLED").every((r) => !isDelivered(r.status) && r.date >= today);
}

export async function planCourseStartChange(
  course: StartChangeCourse,
  rows: StartChangeRow[],
  newStart: string,
  today: string,
  isOnLeave: (teacherId: string, date: string) => Promise<boolean>,
): Promise<StartChangePlan | StartChangeRefusal> {
  if (newStart < today) return { code: "START_IN_PAST", message: `วันเริ่มใหม่ (${newStart}) ผ่านมาแล้ว — เลือกวันนี้หรือหลังจากนี้` };
  if (!courseNotStarted(course, rows, today)) {
    return { code: "COURSE_STARTED", message: "คอร์สนี้เริ่มเรียนแล้ว — เปลี่ยนวันเริ่มไม่ได้ (ใช้ย้ายคาบรายคาบในแผนแทน)" };
  }
  const plan = rows.filter(isCoursePlanRow).filter((r) => r.status !== "CANCELLED").sort((a, b) => a.date.localeCompare(b.date));
  if (!plan.length) return { code: "NOTHING_TO_MOVE", message: "คอร์สนี้ไม่มีคาบให้ย้าย" };

  // The SAME weekly lay-out creation uses (one per week from the start), in the plan's own order: row i keeps its place —
  // a declared leave stays that week's leave, a make-up stays at the end. A week whose teacher is on an advance leave is
  // SKIPPED, exactly as the automatic make-up skips it (TASK-561) — the row takes the next week.
  const moves: StartChangePlan["moves"] = [];
  const skipped: StartChangePlan["skipped"] = [];
  let candidate = newStart;
  for (const r of plan) {
    while (await isOnLeave(r.teacherId, candidate)) { skipped.push({ teacherId: r.teacherId, date: candidate }); candidate = addDays(candidate, 7); }
    const toStatus = r.status === "CONFIRMED" ? "PENDING" : r.status;
    moves.push({ id: r.id, teacherId: r.teacherId, from: r.date, to: candidate, status: r.status, toStatus });
    candidate = addDays(candidate, 7);
  }
  const later = moves[0]!.to > moves[0]!.from;
  const order = (later ? [...moves].reverse() : moves).map((m) => m.id);

  // The expiry, recomputed THE NORMAL WAY — creation's own formula (`courseBornCeiling` over `courseExpiry`, the plan's last
  // session, the declared absences), over the MOVED plan. A make-up's own week is not part of creation's plan, so the plan end
  // is read from the rows without a link; and the result never ends before the course's own last session (the stretch rule).
  const lastPlanned = moves.filter((m) => !plan.find((r) => r.id === m.id)!.extendedFromId).reduce((mx, m) => (m.to > mx ? m.to : mx), newStart);
  const declared = plan.filter((r) => r.status === "SICK_LEAVE" && r.plannedAtCreation).length;
  const lastAny = moves.reduce((mx, m) => (m.to > mx ? m.to : mx), newStart);
  const born = courseBornCeiling(courseExpiry(newStart, course.size), lastPlanned, declared);
  return { moves, order, expiryDate: born > lastAny ? born : lastAny, needsReconfirm: moves.filter((m) => m.status === "CONFIRMED").length, skipped };
}

export const isStartChangeRefusal = (p: StartChangePlan | StartChangeRefusal): p is StartChangeRefusal => "code" in p;
