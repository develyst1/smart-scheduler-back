// TASK-838 (REQ-127 "เปลี่ยนครู / เวลา ทั้งคอร์ส") — THE PLAN of moving the rest of a course to a new teacher, day and time. PURE: nothing here reads or writes the database; the service applies what this returns.
//
// "One act": the course's still-live sessions dated today or later are MOVED IN PLACE (the same rows, re-dated / re-timed / re-assigned) — nothing is cancelled and nothing is created, so no link a row carries is lost, the first-coach history
// of the delivered rows stays readable, and no family gets a "cancelled" message. 🔑 Which rows is NOT a new definition: `endableSessions` (the end and the pause use it) + the date rule "today or later". The new dates are NOT a new scheduler:
// they are `courseSessionDates(startDate, n)` — the planner course creation and the resume use — one new date per moved row, in order.
import { endableSessions } from "./course-plan";
import { courseSessionDates } from "./recurring";

export interface TeacherTimeRow { id: string; date: string; startTime: string; endTime?: string; status: string; teacherId: string; bookingType?: string }
export type TeacherTimeRefusal = { code: "START_IN_PAST" | "NOTHING_TO_MOVE"; message: string };
export interface TeacherTimeMove {
  id: string;
  from: { date: string; startTime: string; endTime?: string; teacherId: string };
  to: { date: string; startTime: string; teacherId: string };
  status: string;
  /** A CONFIRMED row returns to PENDING (its confirmation was of the OLD slot); every other live status is kept. */
  toStatus: string;
}
export interface TeacherTimePlan {
  moves: TeacherTimeMove[];
  /** Apply in THIS order: a row never lands on a slot a sibling that has not yet left still holds (same teacher · date · time). */
  order: string[];
  n: number;
  firstDate: string;
  lastDate: string;
  /** How many CONFIRMED rows return to PENDING ⇒ the admin re-confirms the course: ONE schedule message per person. */
  needsReconfirm: number;
  /** `true` when the teacher changes ⇒ the old / new coach each get ONE notice per act (never one per session). */
  teacherChanges: boolean;
}

const hhmm = (t: string) => t.slice(0, 5);

export function planCourseTeacherTimeChange(
  rows: TeacherTimeRow[],
  input: { teacherId: string; startDate: string; startTime: string },
  today: string,
): TeacherTimePlan | TeacherTimeRefusal {
  if (input.startDate < today) return { code: "START_IN_PAST", message: `วันเริ่มใหม่ (${input.startDate}) ผ่านมาแล้ว — เลือกวันนี้หรือหลังจากนี้` };
  // THE definition of "still live" (the end and the pause use it) — and only what has not happened yet. A delivered row (ATTENDED / NO_SHOW / SICK_LEAVE …) and a CANCELLED one are not in `endableSessions`: they never move.
  const live = endableSessions(rows)
    .filter((r) => r.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  if (!live.length) return { code: "NOTHING_TO_MOVE", message: "คอร์สนี้ไม่มีคาบให้ย้าย" };

  const dates = courseSessionDates(input.startDate, live.length); // ONE new date per moved row, in order — no second scheduler
  const moves: TeacherTimeMove[] = live.map((r, i) => ({
    id: r.id,
    from: { date: r.date, startTime: r.startTime, ...(r.endTime ? { endTime: r.endTime } : {}), teacherId: r.teacherId },
    to: { date: dates[i]!, startTime: input.startTime, teacherId: input.teacherId },
    status: r.status,
    toStatus: r.status === "CONFIRMED" ? "PENDING" : r.status,
  }));

  // Order the writes so no row lands on a slot another moving row still holds (the unique index would refuse it though that row is about to leave). A slot = teacher · date · hour.
  const slot = (teacherId: string, date: string, time: string) => `${teacherId}|${date}|${hhmm(time)}`;
  const holder = new Map(moves.map((m) => [slot(m.from.teacherId, m.from.date, m.from.startTime), m.id]));
  const pending = new Set(moves.map((m) => m.id));
  const order: string[] = [];
  while (pending.size) {
    const next = moves.find((m) => {
      if (!pending.has(m.id)) return false;
      const h = holder.get(slot(m.to.teacherId, m.to.date, m.to.startTime));
      return h === undefined || h === m.id || !pending.has(h);
    });
    const pick = next ?? moves.find((m) => pending.has(m.id))!; // a cycle cannot arise from a monotone lay-out; if it ever did, the unique index refuses it loudly (SLOT_TAKEN) — never silently
    order.push(pick.id);
    pending.delete(pick.id);
  }

  return {
    moves,
    order,
    n: moves.length,
    firstDate: dates[0]!,
    lastDate: dates[dates.length - 1]!,
    needsReconfirm: moves.filter((m) => m.toStatus !== m.status).length,
    teacherChanges: moves.some((m) => m.from.teacherId !== m.to.teacherId),
  };
}

export const isTeacherTimeRefusal = (p: TeacherTimePlan | TeacherTimeRefusal): p is TeacherTimeRefusal => "code" in p;
