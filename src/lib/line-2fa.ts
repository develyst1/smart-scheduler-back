// SPEC-071 Amendment #2 / TASK-232 (REQ-079 §2) — the 6-digit verification step, BUILT and shipped OFF.
//
// 🔴 Why it exists while being switched off: the owner raised the risk with the customer — anyone who knows a
// phone number can see that family's children and act for them — and **the customer refused the extra step**.
// The refusal is on the record (REQ-079 §2, `SYSTEM-FACTS.md`).
//
// So it ships as a SETTING (`line_parent_2fa`), not a stub: **turning it on must never be a rebuild.** The
// branch, the storage and the verification are all here from day one, and the switch is the only thing that
// changes. That property is what the task called the deliverable — not the branch itself.
//
// 🚫 **The numbers below are NOT decided.** Lifetime, attempt count and lockout return to the OWNER the day
// this is switched on. They are explicitly **not** inherited from the two deleted designs (the family code and
// the invite code) — both were removed, and their parameters went with them. Placeholders with a stated reason
// beat plausible-looking values that someone later mistakes for a decision.

/** ⚠️ PLACEHOLDER — the owner decides on switch-on. See the file header. */
export const TWOFA_TTL_MINUTES = 10;
/** ⚠️ PLACEHOLDER — the owner decides on switch-on. See the file header. */
export const TWOFA_MAX_ATTEMPTS = 3;

export const TWOFA_DIGITS = 6;

/**
 * A 6-digit code. `crypto.getRandomValues` rather than `Math.random`, because a predictable verification code
 * is not a verification of anything — and this is the one piece here whose weakness would be invisible.
 */
export function generate2faCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0]! % 10 ** TWOFA_DIGITS).padStart(TWOFA_DIGITS, "0");
}

/** Constant-ish comparison on a trimmed string. Pure, so "what counts as a match" is one rule. */
export const matches2faCode = (expected: string | null | undefined, given: string): boolean =>
  !!expected && expected === given.trim();

/**
 * 🔴 **NOT IMPLEMENTED, ON PURPOSE — and it fails LOUDLY rather than silently.**
 *
 * How a parent RECEIVES the six digits is not specified anywhere: there is no SMS integration in this system,
 * and sending them to the LINE chat that is being verified would verify nothing. That is a decision for the
 * owner on switch-on — **it is a transport, not a rebuild**, which is why everything around it is complete.
 *
 * It throws instead of returning, so switching the setting on without wiring delivery is discovered
 * immediately by whoever flips it, rather than by a family who can no longer reach their children's schedule.
 * A silent no-op here would be the worst of both worlds: the feature on, and nobody able to pass it.
 */
export function deliver2faCode(_lineUserId: string, _code: string): never {
  throw new Error(
    "line_parent_2fa is ON but code delivery is not configured. How the parent receives the 6 digits is an " +
      "owner decision (there is no SMS integration, and sending them to the chat being verified proves " +
      "nothing). See lib/line-2fa.ts — TASK-232.",
  );
}
