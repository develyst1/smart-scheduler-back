// 🔴 TASK-725 (owner GO "ตามนั้น", shape 1) — the admin LINE link is tied to the WEB USER. Two halves of ONE act:
//   ISSUE  — a signed-in web user asks for a one-time code (`POST /me/line-link-code`): 8 symbols, 10 minutes, single use, stored HASHED, tied to THIS user.
//   LINK   — that person types it in the OA chat (`verifyAndLink`, admin branch): the code names the USER, the chat's LINE id is written to
//            `users.line_user_id`, the code is burned in the SAME statement. The shared admin code is RETIRED: nothing here reads an environment value.
// The decisions that are easy to get wrong, each pinned in `admin-line-link-task725.test.ts`:
// · SINGLE USE is atomic: burn and link are ONE `UPDATE … WHERE hash = $h AND expires > now AND disabled_at IS NULL RETURNING id`, so two chats typing the
//   same code at the same instant cannot both win — the second matches zero rows.
// · Every refusal is the SAME reply to the chat (the reason goes to the log; never the typed text) and counts as a MISS on the per-LINE-account limiter.
// · A LINE account belongs to AT MOST one user (the partial unique index is the backstop; the pre-check gives a clean refusal instead of a 23505).
// · Re-linking a user who already has a LINE account REPLACES it: the earlier account stops being an admin and its menu is settled like a removal.
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { ApiException, pgErrorCode } from "../lib/http";
import { removeAdminLineUserId } from "../lib/line-admin";
import { adminCodeLimit, adminLinkBlocked, recordAdminLinkAttempt } from "../lib/line-admin-code";
import { LINK_CODE_TTL_MS, generateLinkCode, hashLinkCode, linkCodeExpiry, looksLikeLinkCode, normalizeLinkCode } from "../lib/line-link-code";
import { settleMenuAfterRemoval } from "./line-admin-links.service";

/**
 * 📋 ENGINEER WORDING — LISTED, NOT APPROVED (owner rule 2026-10-07: a refusal no screen can reach). These two are BACKSTOPS: the web screen never offers the
 * "get a code" action to a coach account (it already knows `user.teacherId` from `/me`), and a DISABLED user cannot sign in at all, so the sign-in guard
 * answers 401 before this route is ever reached. They are NOT in the copy set; they exist so a direct API call is refused with a sentence, not a stack.
 */
export const LINE_LINK_NOT_FOR_COACH = () => new ApiException(403, "LINE_LINK_NOT_FOR_COACH", "บัญชีครูผูก LINE แอดมินไม่ได้");
export const LINE_LINK_USER_DISABLED = () => new ApiException(403, "USER_DISABLED", "บัญชีนี้ถูกปิดใช้งาน");

/** How many times a freshly drawn code may collide with a live one (31^8 codes ⇒ effectively never) before we give up loudly. */
const ISSUE_ATTEMPTS = 5;

export type IssuedLinkCode = { code: string; expiresAt: string; expiresInSeconds: number };

/** ISSUE: a new code for THIS user, replacing any earlier one. The plain code is returned here and NOWHERE else — only its hash is stored. */
export async function issueLineLinkCode(userId: string, exec: any = db, now: number = Date.now()): Promise<IssuedLinkCode> {
  const row = await exec.query.users.findFirst({ columns: { id: true, teacherId: true, disabledAt: true }, where: (u: any, { eq: e }: any) => e(u.id, userId) });
  if (!row) throw new ApiException(404, "NOT_FOUND", "ไม่พบผู้ใช้");
  if (row.disabledAt) throw LINE_LINK_USER_DISABLED();
  if (row.teacherId) throw LINE_LINK_NOT_FOR_COACH();
  for (let attempt = 0; attempt < ISSUE_ATTEMPTS; attempt++) {
    const code = generateLinkCode();
    const expires = linkCodeExpiry(now);
    try {
      await exec.update(users).set({ lineLinkCodeHash: hashLinkCode(code), lineLinkCodeExpiresAt: expires }).where(eq(users.id, userId));
    } catch (e) {
      if (pgErrorCode(e) === "23505") continue; // the hash collided with another user's live code: draw again
      throw e;
    }
    return { code, expiresAt: expires.toISOString(), expiresInSeconds: LINK_CODE_TTL_MS / 1000 };
  }
  throw new ApiException(500, "INTERNAL", "ออกรหัสไม่สำเร็จ ลองใหม่อีกครั้ง");
}

/** `reason` is for the LOG only; the chat gets the same reply for every `ok: false`. */
export type LinkResult = { ok: true; userId: string } | { ok: false; reason: string };

/**
 * LINK: the typed text is checked against UNEXPIRED, UNUSED code hashes. A hit writes `users.line_user_id` for THAT user and burns the code in the same statement.
 * `limit` / `now` are injectable so the miss limiter and the 10-minute window are testable without waiting.
 */
export async function linkLineByCode(
  lineUserId: string,
  typed: string,
  opts: { exec?: any; now?: number; limit?: typeof adminCodeLimit } = {},
): Promise<LinkResult> {
  const exec = opts.exec ?? db;
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? adminCodeLimit;
  if (adminLinkBlocked(lineUserId, now, limit)) return { ok: false, reason: "over the miss limit" };
  const miss = (reason: string): LinkResult => {
    recordAdminLinkAttempt(lineUserId, { miss: true, reason }, now, limit);
    return { ok: false, reason };
  };

  const normalized = normalizeLinkCode(typed);
  if (!looksLikeLinkCode(normalized)) return miss("not shaped like a code"); // no database read for text that cannot be a code
  const hash = hashLinkCode(normalized);

  const row = await exec.query.users.findFirst({
    columns: { id: true, lineUserId: true, teacherId: true, disabledAt: true, lineLinkCodeExpiresAt: true },
    where: (u: any, { eq: e }: any) => e(u.lineLinkCodeHash, hash),
  });
  if (!row) return miss("no such live code (wrong, or already used)");
  if (!row.lineLinkCodeExpiresAt || new Date(row.lineLinkCodeExpiresAt).getTime() <= now) return miss("expired");
  if (row.disabledAt) return miss("the user is disabled");
  if (row.teacherId) return miss("a coach account"); // cannot be issued one; refused here too, in case the account became a coach's after issuing

  // This LINE account already belongs to ANOTHER user: refused (the same reply), logged.
  const holder = await exec.query.users.findFirst({ columns: { id: true }, where: (u: any, { and: a, eq: e, ne: n }: any) => a(e(u.lineUserId, lineUserId), n(u.id, row.id)) });
  if (holder) return miss("this LINE account is already linked to another user");

  // Re-link: the user's EARLIER LINE account, read BEFORE the write (the write replaces it).
  const previous: string | null = row.lineUserId && row.lineUserId !== lineUserId ? row.lineUserId : null;

  let burned: Array<{ id: string }>;
  try {
    burned = await exec
      .update(users)
      .set({ lineUserId, lineLinkCodeHash: null, lineLinkCodeExpiresAt: null })
      .where(and(eq(users.id, row.id), eq(users.lineLinkCodeHash, hash), gt(users.lineLinkCodeExpiresAt, new Date(now)), isNull(users.disabledAt)))
      .returning({ id: users.id });
  } catch (e) {
    if (pgErrorCode(e) === "23505") return miss("this LINE account is already linked to another user (race)");
    throw e;
  }
  if (!burned.length) return miss("the code was used or expired a moment ago (race)");

  recordAdminLinkAttempt(lineUserId, { miss: false }, now, limit);
  // …and that earlier account stops being an admin (a legacy copy of it goes too) and falls back to its own menu.
  if (previous) {
    await removeAdminLineUserId(previous, exec);
    await settleMenuAfterRemoval(previous, exec);
  }
  return { ok: true, userId: row.id };
}

/** `GET /me` → `user.lineLinked`: has THIS user linked a LINE account? A boolean only — the LINE id never leaves the server. */
export async function isLineLinked(userId: string, exec: any = db): Promise<boolean> {
  const row = await exec.query.users.findFirst({ columns: { lineUserId: true }, where: (u: any, { eq: e }: any) => e(u.id, userId) });
  return !!row?.lineUserId;
}
