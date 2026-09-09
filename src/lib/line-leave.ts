// SPEC-041 / TASK-135 (REQ-046) — leave has always been recorded per session (bookingId); what was missing
// was making the SESSION visible in LINE. These are the pure pieces of that: which child step is needed, and
// how one session reads. No DB, no LINE API — the service supplies the rows it already loads
// (`findTodayBookingsForParent` fetches `with: { student, teacher, subject }`).
import { hhmm } from "./time";
import { t, type Lang } from "./line-i18n";
import { weekdayOf } from "./recurring";

export interface LeaveSession {
  id: string;
  studentId: string;
  /** 🔑 TASK-316 — the date is part of a session's identity the moment the picker looks past today. */
  date: string;
  startTime: string;
  student: { name: string; nickname?: string | null };
  teacher?: { nickname: string } | null;
  subject?: { name: string } | null;
}

const childName = (s: LeaveSession["student"]) => s.nickname || s.name;

/** The children that actually have an eligible session, in the order their first session appears (the rows
 *  arrive sorted by time), one entry per child. */
export function childrenWithSessions(sessions: LeaveSession[]): Array<{ studentId: string; name: string }> {
  const seen = new Map<string, string>();
  for (const b of sessions) if (!seen.has(b.studentId)) seen.set(b.studentId, childName(b.student));
  return [...seen].map(([studentId, name]) => ({ studentId, name }));
}

/** AC-3: ask "which child?" only when ≥2 children each have a session today — one child stays one tap (AC-5). */
export const needsChildStep = (sessions: LeaveSession[]): boolean => childrenWithSessions(sessions).length >= 2;

/** One session as the parent reads it: time · teacher · program. Used for the picker button (clamped by the
 *  reply layer to LINE's 20-char label limit) and, unclamped, in the prompt body. */
export const sessionLabel = (b: LeaveSession, lang: Lang): string =>
  t("session_row", lang, {
    time: hhmm(b.startTime),
    teacher: b.teacher?.nickname ?? "-",
    program: b.subject?.name ?? "-",
  });

/** `2026-09-22` → `22/09`. Day-first, like every other date a parent is shown (TASK-280's rule). */
export const shortDate = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * 🔴 TASK-316 §2/§3 — the TWO forms a widened picker needs, and why they are not one string.
 *
 * `sessionLabel` is `time · teacher · program`, which was **correct while the list was one day wide**: the date
 * was implied by the question. 🔴 **Widen the window and one weekly course produces three IDENTICAL rows** —
 * *"15:00 · Bank · Skateboard"*, this Tuesday, next Tuesday, the one after — and a parent cannot tell which
 * class they are cancelling. 🔑 That is `§15`'s defect on the parent's side, arriving BEFORE the act rather
 * than after it.
 *
 * ## The decision `§3` asked me to make, and to state
 * · **BODY — unclamped, so it names the date in FULL:** `พฤหัสบดี 22/09 · 15:00 · ครูBank · Skateboard`. The
 *   weekday first because that is how a family holds its week; the date second because that is what tells one
 *   Tuesday from the next.
 * · **BUTTON — LINE clamps at 20 characters, and `time · teacher · program` ALREADY overflows it today**, so a
 *   prepended date would be eaten at one end or the other. ⇒ the button carries **`22/09 15:00`** — 11
 *   characters, language-neutral, and **exactly the pair that distinguishes one row from another.** Teacher and
 *   program are dropped from the BUTTON precisely because they are identical across the rows being told apart;
 *   the body beside it still names them.
 * 🚫 **Never a half-printed date** — a truncated one looks like information. **This form cannot be truncated.**
 * 📌 Date+time is a genuine key for one child: a child cannot be in two classes at the same moment.
 */
export const sessionPick = (b: LeaveSession, lang: Lang): { button: string; body: string } => ({
  button: `${shortDate(b.date)} ${hhmm(b.startTime)}`,
  body: `${t(`ob_dow_${weekdayOf(b.date)}`, lang)} ${shortDate(b.date)} · ${sessionLabel(b, lang)}`,
});
