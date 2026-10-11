// 🔴🔴 TASK-534 (SEC-1) → TASK-725 — the GATE in front of the ADMIN link a chat types. TASK-725 RETIRED the shared admin code: nothing in this file (or in
// `verifyAndLink`) reads an environment value any more, there is no default and no fallback, and no value written anywhere in the repo works as a code.
// A LINE account becomes an admin ONLY by typing the ONE-TIME code a signed-in WEB USER asked for (`services/admin-line-link.service.ts`).
//
// What survives, because SEC-1's reasoning still holds for a short-lived code just as it did for a shared one:
// 1. Every refusal — wrong · expired · already used · a LINE account already on another user · too many misses — is the SAME reply, because the person typing
//    may be the attacker. The REASON goes to the log only.
// 2. A per-LINE-user limit on MISSES, on the shop-front's limiter class (TASK-475). The two-strikes mute is NOT that limit: the un-mute word (`เปิดเมนู`)
//    clears it at once, so strike → strike → un-mute → retry was an unlimited guessing loop.
// 3. The typed text is NEVER logged (a near-miss of a real code would put most of it in the log).
import { ShopfrontRateLimit } from "./shopfront-rate-limit";

/** Misses per LINE user per window before that user is refused without the code even being looked up. */
export const ADMIN_CODE_WINDOW_MS = 60 * 60_000;
export const ADMIN_CODE_MISS_LIMIT = 5;
/** The shop-front's limiter, reused (TASK-475): same miss-counting, its limits passed in. The same honest limits apply — one
 *  process's memory, reset by a restart, and N× under PM2 cluster mode. A new LINE account starts at zero: the code's STRENGTH
 *  (8 symbols, 10 minutes, single use) is what defends against that, the limit is what makes walking it from one account pointless. */
export const adminCodeLimit = new ShopfrontRateLimit({ windowMs: ADMIN_CODE_WINDOW_MS, missLimit: ADMIN_CODE_MISS_LIMIT, totalLimit: Number.POSITIVE_INFINITY });

const who = (lineUserId: string) => `…${lineUserId.slice(-4)}`;

/** Is this LINE account over the miss limit? ⇒ it is refused WITHOUT any lookup (and the log says why). */
export function adminLinkBlocked(lineUserId: string, now: number = Date.now(), limit = adminCodeLimit): boolean {
  if (!limit.blocked(lineUserId, now)) return false;
  console.warn(`🔴 [SEC-1] admin link code: ${who(lineUserId)} is over ${ADMIN_CODE_MISS_LIMIT} misses in ${ADMIN_CODE_WINDOW_MS / 60_000} min — refused without checking.`);
  return true;
}

/** Record one attempt: a MISS counts toward the limit; a hit is recorded but does NOT reset earlier misses (they age out with the window). `reason` is for the LOG only — never the typed text. */
export function recordAdminLinkAttempt(lineUserId: string, outcome: { miss: false } | { miss: true; reason: string }, now: number = Date.now(), limit = adminCodeLimit): void {
  limit.record(lineUserId, now, outcome.miss);
  if (outcome.miss) console.warn(`🔴 [SEC-1] admin link code: a miss from ${who(lineUserId)} (${outcome.reason}).`);
}
