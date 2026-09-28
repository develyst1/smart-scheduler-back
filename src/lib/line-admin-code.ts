// 🔴🔴 TASK-534 (SEC-1) — the ADMIN CODE a chat types to become a LINE admin. Pure except for the log and the limiter's memory.
//
// What was wrong: the prompt printed the code as an EXAMPLE (`(เช่น 229)`), and the check defaulted to that same value
// (`?? "229"`) — so anyone who followed the OA could read it and link themselves as an admin, then receive every family's
// leave notices. There was no approval step.
//
// The rules here, each pinned in `sec1-admin-code-task534.test.ts`:
// 1. NO DEFAULT. Unset, shorter than `ADMIN_CODE_MIN_LENGTH`, or a RETIRED value ⇒ admin linking is REFUSED, and the log says
//    why, loudly. 🔑 The LINKING is refused, not the boot (Sober's ruling): a boot refusal would take the whole product down over
//    one config value — a worse outage than the hole it closes.
// 2. NOTHING about the code reaches the chat — not the value, not its length, not which check failed. Every refusal (wrong code ·
//    code not configured · too many misses) is the SAME reply, because the person typing may be the attacker.
// 3. A per-LINE-user limit on MISSES, on the shop-front's limiter class (TASK-475). The two-strikes mute is NOT that limit: the
//    un-mute word (`เปิดเมนู`) clears it at once, so strike → strike → un-mute → retry was an unlimited guessing loop.
// 4. The typed text is NEVER logged (a near-miss of the real code would put most of it in the log).
//
// 📌 Approval-readiness: this module is the GATE only. When admin linking gains an approval step (the next security task), the
// gate stays in front untouched; what moves is the SUCCESS half in `verifyAndLink` (add the id + link the menu + "linked ✅"),
// which becomes "queue a request" — the way a teacher link already works.
import { timingSafeEqual } from "node:crypto";
import { ShopfrontRateLimit } from "./shopfront-rate-limit";

export const ADMIN_CODE_ENV = "LINE_ADMIN_VERIFY_CODE";

/**
 * 8 characters. Why: the code is typed on a phone by a human, so it must stay typeable; and with the miss limit below (5 per
 * hour per LINE account) even an all-digit 8-character code takes on the order of 10^8 / 5 ≈ 20 million hours to walk per
 * account. The same minimum the web app's bootstrap password already uses (TASK-380), so the owner meets one rule, not two.
 */
export const ADMIN_CODE_MIN_LENGTH = 8;

/** Values that were ever PUBLISHED (printed in a prompt, or shipped as the default) — refused even if someone sets them again. */
const RETIRED: ReadonlySet<string> = new Set(["229"]);

export type AdminCodeProblem = "unset" | "short" | "retired";
export type AdminCodeConfig = { ok: true; code: string } | { ok: false; problem: AdminCodeProblem };

/** The configured code, or why it cannot be used. Never a default. */
export function adminCodeConfig(raw: string | undefined | null): AdminCodeConfig {
  const code = (raw ?? "").trim();
  if (!code) return { ok: false, problem: "unset" };
  if (RETIRED.has(code)) return { ok: false, problem: "retired" };
  if (code.length < ADMIN_CODE_MIN_LENGTH) return { ok: false, problem: "short" };
  return { ok: true, code };
}

/** Constant-time comparison of what was typed against the configured code (lengths differ ⇒ false, without comparing). */
export function adminCodeMatches(expected: string, typed: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(typed.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Misses per LINE user per window before that user is refused without the code even being compared. */
export const ADMIN_CODE_WINDOW_MS = 60 * 60_000;
export const ADMIN_CODE_MISS_LIMIT = 5;
/** The shop-front's limiter, reused (TASK-475): same miss-counting, its limits passed in. The same honest limits apply — one
 *  process's memory, reset by a restart, and N× under PM2 cluster mode. A new LINE account starts at zero: the code's STRENGTH
 *  is what defends against that, the limit is what makes walking it from one account pointless. */
export const adminCodeLimit = new ShopfrontRateLimit({ windowMs: ADMIN_CODE_WINDOW_MS, missLimit: ADMIN_CODE_MISS_LIMIT, totalLimit: Number.POSITIVE_INFINITY });

const who = (lineUserId: string) => `…${lineUserId.slice(-4)}`;

/**
 * THE gate. True only when the code is configured correctly, this user is not over the miss limit, and the typed text matches.
 * Every false is indistinguishable to the caller on purpose (rule 2); the REASON goes to the log only.
 */
export function checkAdminCode(lineUserId: string, typed: string, env: string | undefined, now: number = Date.now(), limit = adminCodeLimit): boolean {
  if (limit.blocked(lineUserId, now)) {
    console.warn(`🔴 [SEC-1] admin code: ${who(lineUserId)} is over ${ADMIN_CODE_MISS_LIMIT} misses in ${ADMIN_CODE_WINDOW_MS / 60_000} min — refused without checking.`);
    return false;
  }
  const cfg = adminCodeConfig(env);
  if (!cfg.ok) {
    limit.record(lineUserId, now, true);
    console.error(`🔴🔴 [SEC-1] admin linking REFUSED — ${ADMIN_CODE_ENV} is ${cfg.problem}. Set a code of at least ${ADMIN_CODE_MIN_LENGTH} characters (never a retired one). Nobody can link as an admin until then.`);
    return false;
  }
  if (!adminCodeMatches(cfg.code, typed)) {
    limit.record(lineUserId, now, true);
    console.warn(`🔴 [SEC-1] admin code: a wrong code from ${who(lineUserId)}.`);
    return false;
  }
  limit.record(lineUserId, now, false);
  return true;
}
