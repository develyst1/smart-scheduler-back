// Which branch handles an inbound LINE text message (TASK-046). Pure, so the ORDER — the thing that was
// actually broken — is explicit and unit-testable.
//
// The bug: already-linked routing ran BEFORE the linking conversation, so an already-linked user who typed
// `สมัคร` had their next message ("2" = teacher) swallowed by the parent command handler → the CHOOSE_ROLE /
// AWAIT_CODE branches were unreachable and the role change could never complete.
//
// The rule (the file already applied it to AWAIT_STUDENT_NAME): **an in-progress multi-turn conversation wins
// over already-linked routing.** Only when no conversation is in progress does the user's existing link decide.

export type MessageRoute = "add-student" | "linking" | "linked" | "welcome";

export function decideMessageRoute(
  sessionStep: string | null | undefined,
  linkedRole: string | null | undefined,
): MessageRoute {
  if (sessionStep === "AWAIT_STUDENT_NAME") return "add-student";
  if (sessionStep === "CHOOSE_ROLE" || sessionStep === "AWAIT_CODE") return "linking";
  if (linkedRole) return "linked";
  return "welcome";
}

/**
 * "Move, don't duplicate": which roster table still holds the OLD link that must be cleared when a LINE user
 * (re)links as `newRole`. One LINE user ⇒ one active roster link, so `detectLinkedRole` (teacher before parent)
 * can't silently hide the other surface. Pure, so the mapping is testable without a DB.
 */
export const otherRosterTable = (newRole: "customer" | "teacher"): "parents" | "teachers" =>
  newRole === "teacher" ? "parents" : "teachers";
