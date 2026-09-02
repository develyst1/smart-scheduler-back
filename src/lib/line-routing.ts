// Which branch handles an inbound LINE text message (TASK-046). Pure, so the ORDER — the thing that was
// actually broken — is explicit and unit-testable.
//
// The bug: already-linked routing ran BEFORE the linking conversation, so an already-linked user who typed
// `สมัคร` had their next message ("2" = teacher) swallowed by the parent command handler → the CHOOSE_ROLE /
// AWAIT_CODE branches were unreachable and the role change could never complete.
//
// The rule (the file already applied it to AWAIT_STUDENT_NAME): **an in-progress multi-turn conversation wins
// over already-linked routing.** Only when no conversation is in progress does the user's existing link decide.

// ─────────── SPEC-071 / TASK-231 (REQ-079 §16) — silence by default ───────────
//
// 🔴 This is a CHANGE TO SHIPPED BEHAVIOUR, not a new capability. The deployed bot answers stray text in an
// idle chat — the owner's screenshot shows `เมนู` and `yo` getting replies **while a human was about to
// reply** — and AC-16 takes that away. `"welcome"` is therefore replaced by `"silence"`: the route still
// exists, it just delivers nothing.
//
// ⚠️ The risk here is NOT "still too loud". It is **"silenced the wrong branch and nobody notices for a
// week"** — a parent typing `ลา` to report sick leave, or a teacher typing `ตาราง`, must still be answered.
// Those are recognised COMMANDS, not stray text; what AC-16 removes is the unconditional fallback that
// answered everything else. The enumeration is in `line-webhook.service.ts` at each site.

export type MessageRoute = "muted" | "add-student" | "linking" | "linked" | "silence";

export function decideMessageRoute(
  sessionStep: string | null | undefined,
  linkedRole: string | null | undefined,
  opts: { mutedUntil?: Date | string | null; now?: Date } = {},
): MessageRoute {
  // AC-17 — a muted chat delivers NOTHING, whatever it contains. Checked first, because a human is talking in
  // it and every rule below would put the bot on top of them.
  if (isMuted(opts.mutedUntil, opts.now)) return "muted";
  if (sessionStep === "AWAIT_STUDENT_NAME") return "add-student";
  // TASK-232: `AWAIT_2FA` is the verification step between the phone and the children. It is a linking step
  // like the two beside it — listed here rather than defaulting to silence, because a parent who is mid-
  // verification is the clearest case of "an in-progress conversation owns this message".
  if (
    sessionStep === "CHOOSE_ROLE" ||
    sessionStep === "AWAIT_CODE" ||
    sessionStep === "AWAIT_2FA"
  ) {
    return "linking";
  }
  if (linkedRole) return "linked";
  // AC-16 — this was `"welcome"`, which replied to any stray text from an unlinked chat.
  return "silence";
}

/** Is this chat muted right now? `null`/past ⇒ no. Pure, so "in the future" is testable without a clock. */
export function isMuted(mutedUntil: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!mutedUntil) return false;
  const until = mutedUntil instanceof Date ? mutedUntil : new Date(mutedUntil);
  return Number.isFinite(until.getTime()) && until.getTime() > now.getTime();
}

/**
 * AC-18 — two unexpected replies **inside a flow** and the bot hands over to a human.
 *
 * 🔴 `unexpected_count` is the TWO-STRIKES counter. It is **not** the invite/code attempt counter, which was
 * cut with the invite on 2026-09-02. Three times now these two have nearly gone together on one sentence, so
 * the distinction lives in the migration, in `schema.ts`, in a comment-stripping test — and here.
 *
 * Pure, so the boundary is exact: **1 → still trying, 2 → hand over.** Never 3 — a parent must not be trapped
 * in a loop with a machine while a person is sitting in the same chat.
 */
export const HANDOVER_AT = 2;
export const shouldHandOver = (unexpectedCount: number): boolean => unexpectedCount >= HANDOVER_AT;

/** How long the bot stays out of a chat after a handover. Long enough for a person to actually reply. */
export const MUTE_MINUTES = 60;
export const muteUntilFrom = (now: Date = new Date()): Date =>
  new Date(now.getTime() + MUTE_MINUTES * 60_000);

// ─────────── TASK-231 (reopened) — a session goes stale, and that is what §16 actually reported ───────────
//
// 🔴 The screenshot was never the idle-chat fallbacks. Both strings — `เมนู` → *"เบอร์โทรไม่ถูกต้อง…"* and
// `yo` → *"ไม่พบครูชื่อเล่น yo"* — come from **`AWAIT_CODE`**, and `line_link_sessions` rows never expired. An
// abandoned `สมัคร` therefore left that chat treating **every message it ever sent** as a code attempt,
// permanently. Silencing the fallbacks does not touch it; this does.
//
// ⚠️ **INACTIVITY, not age.** `updated_at` carries `$onUpdate` and the handler touches it on every inbound
// message a session handles, so a moving conversation keeps refreshing itself and **a parent typing slowly is
// never dropped mid-registration**. Bounding by age instead would create exactly that failure.
//
// Nothing is deleted: an expired row stays for the record, it simply stops being authoritative.

/** How long a linking/add-student conversation survives with no inbound message at all. */
export const SESSION_IDLE_MINUTES = 30;

/**
 * Has this session gone quiet long enough to stop owning the chat? Pure, so the boundary is testable without a
 * clock — and it takes the string a DB row actually returns as readily as a `Date`.
 *
 * A missing/unparseable `updated_at` is treated as **expired**: a row we cannot date is a row we cannot trust
 * to still be someone's live conversation, and the failure mode of guessing "fresh" is the permanent one.
 */
export function isSessionExpired(
  updatedAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!updatedAt) return true;
  const at = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  if (!Number.isFinite(at.getTime())) return true;
  return now.getTime() - at.getTime() > SESSION_IDLE_MINUTES * 60_000;
}

/**
 * "Move, don't duplicate": which roster table still holds the OLD link that must be cleared when a LINE user
 * (re)links as `newRole`. One LINE user ⇒ one active roster link, so `detectLinkedRole` (teacher before parent)
 * can't silently hide the other surface. Pure, so the mapping is testable without a DB.
 */
export const otherRosterTable = (newRole: "customer" | "teacher"): "parents" | "teachers" =>
  newRole === "teacher" ? "parents" : "teachers";
