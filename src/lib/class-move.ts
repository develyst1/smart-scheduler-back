// TASK-516 (owner ruling: "ย้ายคาบแจ้งทั้งคู่" — announce a move to both) — what counts as a MOVE, and how a slot prints. Pure.
//
// 🔑 ONLY a real move is announced: the DATE or the START TIME changed. A note, a rate, a subject or a teacher change alone is not
// a move — a "move" notice that fires on an unrelated edit is worse than silence (it teaches everyone to ignore the notice).
// Times are compared as `HH:MM` (the DB returns `10:00:00`, a request sends `10:00`): the same time spelt twice is not a move.
import { hhmm } from "./time";
import { ddmmyyyy } from "./time";

export type Slot = { date: string; startTime: string; endTime: string };

export function isRealMove(before: { date: string; startTime: string }, after: { date: string; startTime: string }): boolean {
  return before.date !== after.date || hhmm(before.startTime) !== hhmm(after.startTime);
}

/**
 * A slot as the move notice prints it: `DD-MM-YYYY HH:MM-HH:MM` — the house date (TASK-318) and the house time range.
 * 🔑 TOTAL: an incomplete slot (no date or no start) is `undefined`, so its line is DROPPED — a poor message must never become NO
 * message (the renderer threw on a partial payload; TASK-345's walker found it the first time it rendered this kind).
 */
export const slotLine = (s?: Partial<Slot> | null): string | undefined =>
  s?.date && s.startTime ? `${ddmmyyyy(s.date)} ${hhmm(s.startTime)}${s.endTime ? `-${hhmm(s.endTime)}` : ""}` : undefined;
