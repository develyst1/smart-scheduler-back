// REQ-020 Stage 2 / TASK-075 — the rules for claiming and approving a teacher LINE link.
//
// Pure, so every decision below is unit-tested without a database. The queries live in
// `services/teacher-link.service.ts`.
//
// The property this file exists to protect: **a claim never grants anything.** Typing a nickname used to bind
// that teacher's account to whoever typed it. Now it produces a request, and approval is the only grant.

import { decideTeacherMatch } from "./line-pairing";

/** What a nickname claim should do. */
export type ClaimOutcome =
  /** No teacher by that nickname — tell them, create nothing. */
  | "not-found"
  /** Exactly one match, and they're free — queue a request naming that teacher. */
  | "pending"
  /** Several teachers share the nickname — queue a request with NO teacher; staff decide who it is. */
  | "pending-ambiguous"
  /** That teacher already belongs to another LINE account — refuse at request time (never queue it). */
  | "already-linked";

export interface ClaimTeacher {
  id: string;
  lineUserId?: string | null;
  archived?: boolean | null;
}

/**
 * Decide what a claim does, from the matches alone.
 *
 * ⚠️ **`already-linked` is refused here, not deferred to approval.** If it became a pending request, approving
 * it would silently move a live teacher account to a stranger — the exact theft this task prevents. Same rule
 * the immediate-bind path already enforced (`line-webhook.service.ts:171`), kept rather than relaxed.
 *
 * ⚠️ **An archived teacher is `not-found`.** They should not be claimable, and saying "that teacher exists but
 * has left" would leak roster information to an unauthenticated stranger.
 */
export function decideClaim(
  matches: ClaimTeacher[],
  claimantLineUserId: string,
): ClaimOutcome {
  const live = matches.filter((t) => !t.archived);
  const match = decideTeacherMatch(live.length); // reuse TASK-047's rule — no second definition
  if (match === "none") return "not-found";
  if (match === "ambiguous") return "pending-ambiguous";

  const teacher = live[0]!;
  if (teacher.lineUserId && teacher.lineUserId !== claimantLineUserId) return "already-linked";
  return "pending";
}

/** Does this outcome create/refresh a PENDING request? */
export const claimQueues = (o: ClaimOutcome): boolean =>
  o === "pending" || o === "pending-ambiguous";

/**
 * ⚠️ **The bot must not become an oracle.** `pending` and `pending-ambiguous` must be indistinguishable to the
 * person typing — otherwise "your request is with staff" vs "that name is ambiguous" tells a stranger whether a
 * nickname exists, and how many teachers share it. One reply key for both.
 */
export const claimReplyKey = (o: ClaimOutcome): string =>
  o === "not-found"
    ? "verify_teacher_notfound"
    : o === "already-linked"
      ? "verify_teacher_other"
      : "verify_teacher_pending";

export type ApprovalError =
  | "not-pending" // already decided — a double-click must not link twice
  | "teacher-required" // a collision request approved without naming the teacher
  | "teacher-missing" // named teacher no longer exists
  | "teacher-archived" // they left between request and decision
  | "teacher-linked"; // someone else was linked in the meantime

/**
 * Re-validate at approval time. Between request and decision the teacher may have been linked, archived, or
 * removed — approving must **fail cleanly and change nothing**, never overwrite a live link.
 *
 * Returns the teacher id to link, or the reason it can't proceed.
 */
export function decideApproval(
  request: { status: string; lineUserId: string; teacherId: string | null },
  chosenTeacherId: string | null | undefined,
  teacher: ClaimTeacher | null | undefined,
): { ok: true; teacherId: string } | { ok: false; error: ApprovalError } {
  if (request.status !== "PENDING") return { ok: false, error: "not-pending" };

  // A collision request carries no teacher, so staff MUST name one. Anything else would be a guess.
  const teacherId = request.teacherId ?? chosenTeacherId ?? null;
  if (!teacherId) return { ok: false, error: "teacher-required" };

  if (!teacher) return { ok: false, error: "teacher-missing" };
  if (teacher.archived) return { ok: false, error: "teacher-archived" };
  // Idempotent: approving a request for a teacher already linked to THIS claimant is fine; linked to anyone
  // else is a race we must lose loudly rather than resolve by overwriting.
  if (teacher.lineUserId && teacher.lineUserId !== request.lineUserId) {
    return { ok: false, error: "teacher-linked" };
  }
  return { ok: true, teacherId };
}

/** Thai messages for the approval failures — staff-facing, so they say what to do next. */
export const APPROVAL_MESSAGE: Record<ApprovalError, string> = {
  "not-pending": "คำขอนี้ถูกดำเนินการไปแล้ว",
  "teacher-required": "คำขอนี้มีครูชื่อเล่นซ้ำกัน — ต้องระบุว่าเป็นครูคนไหนก่อนอนุมัติ",
  "teacher-missing": "ไม่พบครูที่เลือก",
  "teacher-archived": "ครูคนนี้ถูกเก็บเข้าคลังแล้ว — อนุมัติไม่ได้",
  "teacher-linked": "ครูคนนี้ถูกผูกกับบัญชี LINE อื่นไปแล้ว — ปลดการผูกก่อนถ้าต้องการเปลี่ยน",
};
