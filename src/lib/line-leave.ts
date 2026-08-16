// SPEC-041 / TASK-135 (REQ-046) — leave has always been recorded per session (bookingId); what was missing
// was making the SESSION visible in LINE. These are the pure pieces of that: which child step is needed, and
// how one session reads. No DB, no LINE API — the service supplies the rows it already loads
// (`findTodayBookingsForParent` fetches `with: { student, teacher, subject }`).
import { hhmm } from "./time";
import { t, type Lang } from "./line-i18n";

export interface LeaveSession {
  id: string;
  studentId: string;
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
export const leaveSessionLabel = (b: LeaveSession, lang: Lang): string =>
  t("leave_pick_row", lang, {
    time: hhmm(b.startTime),
    teacher: b.teacher?.nickname ?? "-",
    program: b.subject?.name ?? "-",
  });
