// TASK-453 (REQ-105 §8/§8.1) — "is this group date in CLASH?", the ONE answer.
//
// 🔑 DERIVED, never stored. A clash is not a state somebody sets: it is what two facts already on the rows MEAN
// together — the group row has yielded its coach-hour (`slot_yielded_at`, set by the Private that took it) AND at
// least one child has since enrolled on that date. Storing it would be a third fact that can disagree with the two
// it is made of, and then something has to decide which wins — the blinding shape TASK-449 took out of the link path.
//
// The attention list, the grid DTO and (when the owner approves the bytes below) both coach messages all ask THIS.

/**
 * The booking types that may MAKE a group row yield — the four lesson types, i.e. a PRIVATE class. Named, because
 * "a Private" is a product word and this is the list it means. 🚫 A GROUP row never takes another group's hour, and
 * OTHER / CAMP are untouched by this feature entirely (@Sober, §2): they refuse on the index as they always have.
 */
export const YIELD_TAKING_TYPES = ["FIRST_TRIAL", "SINGLE_SESSION", "COURSE_PACKAGE", "VOUCHER"] as const;
export const takesYieldedSlot = (bookingType: string | null | undefined): boolean =>
  (YIELD_TAKING_TYPES as readonly string[]).includes(bookingType ?? "");

import { COURSE_LIVE } from "./course-plan";
import { hhmm } from "./time";

/** A group date is in clash when its hour was yielded AND a kid is on it. Both halves, by value, in one place. */
export const isGroupSlotClash = (row: { slotYieldedAt?: Date | string | null; liveSeats?: number | null }): boolean =>
  row.slotYieldedAt != null && (row.liveSeats ?? 0) >= 1;

/**
 * 🟢 **TASK-453b — the owner read these and approved them as drafted (2026-09-24), so they SHIP.** They are the
 * words a coach sees at 07:00 about a class they are not sure they are teaching, which is why they waited for him.
 * The owner reads them before a coach does (@Sober, TASK-453 §5): they
 * ⚠️ The two are NOT the same string, and that is the existing rule, not a choice made here:
 * - the daily reminder's APPENDED lines (`Seats` / `Heads` / `Remark` / `Rental`) all render with `TEMPLATE_LANG` =
 *   `"EN"` — the customer's own printed template — so a fifth appended line is EN among EN siblings. Making this one
 *   Thai would break the template, and that is the owner's decision, not ours (TASK-453 §5, Correction 2).
 * - the weekly digest is ENGLISH-ONLY by REQ-104 §3, under BOTH `line_lang` values.
 */
/** The coach-hour a row stands in — the index's own key, spelled once (`HH:MM`, so `15:00:00` and `15:00` agree). */
export const slotKeyOf = (r: { teacherId?: string | null; date: string; startTime?: string | null }): string =>
  `${r.teacherId ?? ""}|${r.date}|${hhmm(r.startTime ?? "")}`;

/**
 * 🔴 TASK-453b — the coach-hours a CLASH is standing in, from a day's (or a week's) rows.
 *
 * 📌 Keyed on the HOUR, not on the row, because **both** classes carry the note: the group that yielded and the
 * Private that took it are two rows on one `(teacher, date, start)`, and the kids turn up for both. That is the
 * owner's §0 correction, and keying by hour is what makes it true without a second lookup per row.
 *
 * ⚠️ `liveSeatsOf` is the CALLER's, deliberately: the two messages hold genuinely different seat shapes — the daily
 * reminder's are already filtered to `REMINDABLE` by the job and carry no `status` at all, the weekly digest's are
 * raw `bookings` rows. Guessing between them ("no status ⇒ assume live") is the kind of leniency that makes a
 * message right by accident. 🔑 The CLASH RULE itself never moves: it is `isGroupSlotClash`, here, once.
 */
export function clashingSlotKeys(rows: ReadonlyArray<any>, liveSeatsOf: (row: any) => number): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r?.bookingType !== "GROUP") continue;
    if (isGroupSlotClash({ slotYieldedAt: r.slotYieldedAt, liveSeats: liveSeatsOf(r) })) out.add(slotKeyOf(r));
  }
  return out;
}

/** The count for a raw `bookings` row with its `seats` relation — the live set every other reader uses. */
export const liveSeatsOfRow = (r: any): number => (r?.seats ?? []).filter((x: any) => COURSE_LIVE.has(x?.status)).length;

export const CLASH_NOTE_DAILY = "⚠️ CLASH : awaiting admin";
export const CLASH_NOTE_WEEKLY = "⚠️ CLASH — awaiting admin";
