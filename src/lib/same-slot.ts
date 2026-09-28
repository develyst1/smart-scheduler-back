// 🔴 TASK-551 §2 (owner ruling "ตามแนะนำ ไม่ต้องส่ง") — when an admin cancels a make-up and the re-plan puts a new class back in the
// SAME slot, nothing changed for the family (same date, same time) — and for a COACH only if it is also the same coach(es).
//
// 🔑 ONE decider for BOTH audiences (Sober: two comparisons that agree today are two that can disagree later). Pure; EXACT:
// the same date, the same start AND end (as HH:MM — the database's `10:00:00` and a request's `10:00` are the same time spelt twice,
// not a tolerance), and for the coach the same SET of coaches (primary + additional). 🚫 Never "close enough", never "the same week".
// ⚠️ Why the coach set is load-bearing, derived from the re-plan (`reconcileCoursePlan`): the new class copies its coach and its
// times from a TEMPLATE row (the absence it replaces, else the first live session) — NOT from the cancelled make-up — and it copies
// only the PRIMARY coach (no `booking_teachers`). So the re-plan CAN change the coach, drop a co-teacher, or change the time.
// Suppression is the dangerous direction (a missing message is silence nobody reports), so anything short of an exact match SENDS.
import { hhmm } from "./time";

export type SlotFacts = { date: string; startTime: string; endTime: string | null; coachIds: readonly string[] };
export type SameSlot = { family: boolean; coach: boolean };
export const NOT_SAME_SLOT: SameSlot = { family: false, coach: false };

const hm = (t: string | null | undefined) => (t ? hhmm(t) : "");
const coachSet = (ids: readonly string[]) => [...new Set(ids)].sort().join(",");

export function sameSlotReplacement(cancelled: SlotFacts, appended: readonly SlotFacts[]): SameSlot {
  const inSlot = appended.filter((a) => a.date === cancelled.date && hm(a.startTime) === hm(cancelled.startTime) && hm(a.endTime) === hm(cancelled.endTime));
  return {
    family: inSlot.length > 0,
    coach: inSlot.some((a) => coachSet(a.coachIds) === coachSet(cancelled.coachIds)),
  };
}
