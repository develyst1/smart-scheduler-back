// 🔻 TASK-971 (REQ-5016, SPEC-109 §3.3) — the leave QUOTA counts COURSE WEEKS, not leave rows. A course with several slots a week (a PATTERN course: `course_slots` rows ≥ 2) can have two charged leave rows in the same week (a whole-day leave of 2 hours,
// or two single-hour leaves); the week is ONE use of the quota. A charged leave increments `course_packages.leave_used` only when NO OTHER charged leave row of the course sits in the same course week (`courseWeekOf(course.startDate, row.date)`);
// the un-leave / undo decrements only when it removes the week's LAST charged leave row. 🚫 A ONE-SLOT course (no `course_slots`, or one) takes NONE of this: it runs today's exact code (one row a week = one leave a week), by construction —
// `weekQuotaApplies` is the ONE gate, and the answer for such a course is "count it, as always" without a second read.
import { courseWeekOf } from "./course-pattern";

/** The PURE rule: is there no OTHER charged leave in the same course week as `date`? (`otherChargedDates` excludes the row itself.) */
export function noOtherChargedLeaveInWeek(courseStart: string, date: string, otherChargedDates: readonly string[]): boolean {
  const week = courseWeekOf(courseStart, date);
  return !otherChargedDates.some((d) => courseWeekOf(courseStart, d) === week);
}

/** A PATTERN course = two or more `course_slots` rows ("the branch is rows ≥ 2", SPEC-109 AC7). One query by the course id; a course with none / one slot is the one-slot course. */
export async function weekQuotaApplies(exec: any, courseId: string): Promise<boolean> {
  if (!exec?.query?.courseSlots) return false; // an executor that does not carry the relation (the DB-free fakes of the older leave / undo suites) has no pattern course: the old path, byte for byte — never a throw on the one-slot majority
  const slots = await exec.query.courseSlots.findMany({ columns: { id: true }, where: (s: any, { eq }: any) => eq(s.courseId, courseId) });
  return slots.length >= 2;
}

/**
 * Does THIS charged leave (door 1 / door 2) take a NEW unit of the quota? One-slot course ⇒ always (today). Pattern course ⇒ only when no other charged leave row of the course (status SICK_LEAVE, `leave_charged` true, not this row) is in
 * the same course week. Read INSIDE the leave's transaction, after the row's own flip, so the row cannot count itself (it is excluded by id anyway).
 */
export async function leaveTakesNewWeek(exec: any, courseId: string, rowId: string, rowDate: string): Promise<boolean> {
  if (!(await weekQuotaApplies(exec, courseId))) return true;
  return noOtherChargedLeaveInWeek(await courseStartOf(exec, courseId), rowDate, await otherChargedLeaveDates(exec, courseId, rowId));
}

/** Does UNDOING this charged leave return a unit? One-slot ⇒ always (today). Pattern course ⇒ only when it was the week's LAST charged leave row (read after the row's own flip back, so it is already out of the set). */
export async function undoReturnsWeek(exec: any, courseId: string, rowId: string, rowDate: string): Promise<boolean> {
  return leaveTakesNewWeek(exec, courseId, rowId, rowDate); // the same question asked the other way round: «is anyone else charged in this week?»
}

async function courseStartOf(exec: any, courseId: string): Promise<string> {
  const c = await exec.query.coursePackages.findFirst({ columns: { startDate: true }, where: (x: any, { eq }: any) => eq(x.id, courseId) });
  return c.startDate as string;
}

async function otherChargedLeaveDates(exec: any, courseId: string, rowId: string): Promise<string[]> {
  const rows = await exec.query.bookings.findMany({
    columns: { date: true },
    where: (b: any, { and, eq, ne }: any) => and(eq(b.courseId, courseId), eq(b.status, "SICK_LEAVE"), eq(b.leaveCharged, true), ne(b.id, rowId)),
  });
  return rows.map((r: { date: string }) => r.date);
}

/**
 * 🔻 TASK-971 rework (Silver's review, REQ-5016 AC4 «counted in WEEKS») — a PRE-START declaration adds ONE week of expiry per COURSE WEEK declared, not one per hour: a whole-day declaration of 2 hours on a not-yet-started PATTERN course adds ONE week.
 * True when no OTHER declared absence of the course (status SICK_LEAVE, `planned_at_creation` — the shape every declaration is born in, TASK-609) sits in the same course week as `rowDate`. A ONE-slot course ⇒ always true: one row a week, exactly today.
 */
export async function declarationTakesNewWeek(exec: any, courseId: string, rowId: string, rowDate: string): Promise<boolean> {
  const isPatternCourse = await weekQuotaApplies(exec, courseId);
  if (!isPatternCourse) return true;
  const others = await exec.query.bookings.findMany({
    columns: { date: true },
    where: (b: any, { and, eq, ne }: any) => and(eq(b.courseId, courseId), eq(b.status, "SICK_LEAVE"), eq(b.plannedAtCreation, true), ne(b.id, rowId)),
  });
  return noOtherChargedLeaveInWeek(await courseStartOf(exec, courseId), rowDate, others.map((r: { date: string }) => r.date));
}
