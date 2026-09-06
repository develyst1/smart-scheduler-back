// SPEC-072 / TASK-256 — REQ-077's `Coach`, in ONE place.
//
// 🔴 It is one field that may name several people (REQ-078 lets a booking carry additional teachers), and it is
// read by two different builders: the outbox worker enriching a booking-based message, and the daily-reminder
// job building its rows. Two copies of *"which teachers, in which order, joined how"* is how a parent's message
// and a coach's message end up naming different people for the same class.
//
// 📌 Written the day TASK-254 flagged the third copy of a parent lookup. Same class of drift, caught earlier.
//
// Pure — no DB, no clock.

interface TeacherLike {
  nickname?: string | null;
}

/**
 * Every assigned teacher's nickname, **primary first**, deduped, joined with `, `.
 *
 * Primary first because that is the teacher whose class it is; deduped because a teacher listed twice reads as a
 * data fault to the person holding the phone. `undefined` when nobody is named, so the caller's omit-empty rule
 * prints no blank `Coach :` label.
 */
export function joinCoaches(
  primary: TeacherLike | null | undefined,
  additional: ReadonlyArray<{ teacher?: TeacherLike | null } | null | undefined> = [],
): string | undefined {
  const names = [primary?.nickname, ...additional.map((a) => a?.teacher?.nickname)].filter(
    (n): n is string => !!n && !!n.trim(),
  );
  const unique = [...new Set(names)];
  return unique.length ? unique.join(", ") : undefined;
}
