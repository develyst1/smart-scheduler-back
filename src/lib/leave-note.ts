// 🔴 TASK-540 (Tanya TEST-075 F1; Sober's ruling 09-28) — what a LEAVE does to a booking's note, and how an UNDO takes it back.
//
// The defect: both leave writers did `note: reason ?? oldNote`, so a leave WITH a reason overwrote the note in place and nothing kept
// the old one — an undone leave left "Note: <why they were away>" on a CONFIRMED session. It could not be fixed from the data: at Undo
// time a leave's reason and an admin's own note (left alone by a reason-less leave) look identical, so clearing kills one and keeping
// keeps the other. ⇒ the ambiguity is removed at the only moment it does not exist — the leave's own write — by RECORDING it:
//   · a leave WITH a reason: `note = reason`, `leaveNoteReplaced = true`, `noteBeforeLeave = <the note it replaced>` (NULL = none);
//   · a leave without one: the note untouched, `leaveNoteReplaced = false`.
// The Undo restores ONLY what a leave recorded replacing; otherwise the note is left exactly as it is.
// ⚠️ Forward-only, and said so: a leave written BEFORE 0060 has `leaveNoteReplaced = false` (the column default) — what it
// overwrote is unknowable, so its Undo leaves the note as is (Tanya's TEST-075 row is one of these).
// 🔑 A staff EDIT of the note during the leave supersedes the leave's note: the edit path resets `leaveNoteReplaced`, so the Undo
// never overwrites a note a person wrote after the leave (that would be the same defect, quieter).

/** The leave's write to the note columns. `reason ?? before` exactly as before — a non-null reason (even "") replaces. */
export function leaveNoteWrite(reason: string | null | undefined, before: string | null) {
  return reason != null
    ? { note: reason, leaveNoteReplaced: true, noteBeforeLeave: before }
    : { note: before, leaveNoteReplaced: false, noteBeforeLeave: null };
}

/** The Undo's write: the recorded note back, and the record cleared — or NOTHING (an empty set: the note is not touched). */
export function leaveNoteUndo(row: { leaveNoteReplaced?: boolean | null; noteBeforeLeave?: string | null }) {
  return row.leaveNoteReplaced ? { note: row.noteBeforeLeave ?? null, leaveNoteReplaced: false, noteBeforeLeave: null } : {};
}
