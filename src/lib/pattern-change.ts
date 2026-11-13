// 🔻 TASK-971 (REQ-5016 AC5, SPEC-109 §3.4) — CHANGE THE PATTERN mid-course: the UNTAUGHT rows (live, dated `fromDate` or later) are re-placed IN ORDER onto the new weekly pattern (`expandPattern(course.startDate, newSlots, n, new Set(), fromDate)`, the §8b seam),
// the count kept, each row taking its slot's own coach and time; taught / delivered / cancelled rows stay. THE PURE PLANNER, on the shape of `course-teacher-time-change.ts` (TASK-838): the service reads the rows, calls this, and writes in ONE transaction.
import { endableSessions } from "./course-plan";
import { MAX_PATTERN_SLOTS, expandPattern, hhmmOf, patternProblem, type Slot } from "./course-pattern";
import type { TeacherTimeMove, TeacherTimeRow } from "./course-teacher-time-change";

export type PatternChangeRefusal = { code: "PATTERN_INVALID" | "START_IN_PAST" | "NOTHING_TO_MOVE"; status: 400 | 409; message: string };
export interface PatternChangePlan {
  moves: TeacherTimeMove[];
  /** Apply in THIS order: a row never lands on a slot a sibling that has not yet left still holds (same teacher · date · time). */
  order: string[];
  n: number;
  firstDate: string;
  lastDate: string;
  /** rows that were CONFIRMED and go back to PENDING (their confirmation was of the OLD slot) */
  needsReconfirm: number;
  teacherChanges: boolean;
}
export const isPatternChangeRefusal = (p: PatternChangePlan | PatternChangeRefusal): p is PatternChangeRefusal => "code" in p;

const slotKey = (teacherId: string, date: string, time: string) => `${teacherId}|${date}|${hhmmOf(time)}`;

/**
 * Refusals, in this order: PATTERN_INVALID (400 — 1…21 slots, unique (weekday, time), a half-hour grid: `patternProblem(p, 1)`) · START_IN_PAST (400 — `fromDate` before today) · NOTHING_TO_MOVE (409 — no untaught row on or after `fromDate`).
 * A ONE-slot result is legal here (the act then deletes the course's slots and sets its own weekday / time).
 */
export function planPatternChange(
  rows: ReadonlyArray<TeacherTimeRow>,
  input: { startDate: string; fromDate: string; pattern: ReadonlyArray<Slot> },
  today: string,
): PatternChangePlan | PatternChangeRefusal {
  const problem = patternProblem(input.pattern, 1);
  if (problem) return { code: "PATTERN_INVALID", status: 400, message: problem };
  if (input.fromDate < today) return { code: "START_IN_PAST", status: 400, message: `วันที่เริ่มตารางใหม่ (${input.fromDate}) ผ่านมาแล้ว — เลือกวันนี้หรือหลังจากนี้` };
  // THE definition of "still live" (the end, the pause and TASK-838 use it): only what has not happened yet. A delivered / leave / cancelled row never moves.
  const live = endableSessions([...rows])
    .filter((r) => r.date >= input.fromDate)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  if (!live.length) return { code: "NOTHING_TO_MOVE", status: 409, message: "คอร์สนี้ไม่มีคาบที่ยังไม่ได้เรียนตั้งแต่วันนั้นให้ย้าย" };

  const targets = expandPattern(input.startDate, input.pattern, live.length, new Set(), input.fromDate); // ONE new slot per moved row, in order — no second scheduler
  const moves: TeacherTimeMove[] = live.map((r, i) => ({
    id: r.id,
    from: { date: r.date, startTime: r.startTime, ...(r.endTime ? { endTime: r.endTime } : {}), teacherId: r.teacherId },
    to: { date: targets[i]!.date, startTime: targets[i]!.startTime, teacherId: targets[i]!.teacherId },
    status: r.status,
    toStatus: r.status === "CONFIRMED" ? "PENDING" : r.status,
  }));

  // Order the writes so no row lands on a slot another moving row still holds (the unique index would refuse it though that row is about to leave).
  const holder = new Map(moves.map((m) => [slotKey(m.from.teacherId, m.from.date, m.from.startTime), m.id]));
  const pending = new Set(moves.map((m) => m.id));
  const order: string[] = [];
  while (pending.size) {
    const next = moves.find((m) => {
      if (!pending.has(m.id)) return false;
      const h = holder.get(slotKey(m.to.teacherId, m.to.date, m.to.startTime));
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
    firstDate: moves[0]!.to.date,
    lastDate: moves[moves.length - 1]!.to.date,
    needsReconfirm: moves.filter((m) => m.toStatus !== m.status).length,
    teacherChanges: moves.some((m) => m.from.teacherId !== m.to.teacherId),
  };
}

/** The rows `course_slots` holds after the act (SPEC §3.4): 2+ slots ⇒ the new slots in pattern order (`ord` 0…); a ONE-slot result ⇒ none (the course's own weekday / start_time carry it). */
export function slotsToStore(newSlots: ReadonlyArray<Slot>): Slot[] | null {
  return newSlots.length >= 2 && newSlots.length <= MAX_PATTERN_SLOTS ? [...newSlots] : null;
}
