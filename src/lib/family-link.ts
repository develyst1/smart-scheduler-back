// SPEC-071 / TASK-230 (REQ-079) — **the one accessor for "which LINE accounts belong to this family?"**
//
// A family's LINE accounts live in two places by design:
//   · `parents.line_user_id` — the FIRST link, unchanged since the original flow, and
//   · `family_line_links`    — every account added since, through an invite.
//
// Keeping the first column is what makes this additive: every existing reader, index and LINE path is
// untouched (the `booking_teachers` shape from TASK-224). But two sources mean two ways to answer one
// question, and 🔴 **two readers is how the two disagree** — that cost a test rewrite on TASK-228 and it is the
// same failure every time: one surface shows a parent their children, another does not.
//
// ⇒ Nothing outside this file reads either source for this question. `familyLineUserIds` is primary-first, so
// `[0]` is always `parents.line_user_id` and the existing single-account meaning survives everywhere.

import { eq } from "drizzle-orm";
import { db } from "../db";
import { familyLineLinks, parents } from "../db/schema";

/**
 * Every LINE account that may act for this family, **primary first**.
 *
 * Deduped: a parent whose own `line_user_id` was also written into `family_line_links` (an invite redeemed by
 * the account already on the row) must not be messaged twice — a duplicate here is a duplicate push on a
 * phone, which is exactly how a notification channel gets muted.
 */
export async function familyLineUserIds(parentId: string, exec: any = db): Promise<string[]> {
  const parent = await exec.query.parents.findFirst({
    columns: { lineUserId: true },
    where: (p: any, { eq: e }: any) => e(p.id, parentId),
  });
  const links = await exec
    .select({ lineUserId: familyLineLinks.lineUserId })
    .from(familyLineLinks)
    .where(eq(familyLineLinks.parentId, parentId));
  const ids = [
    ...(parent?.lineUserId ? [parent.lineUserId] : []),
    ...links.map((r: any) => r.lineUserId),
  ];
  return [...new Set(ids)];
}

/**
 * Which family is this chat? `null` when the account belongs to none.
 *
 * 🔴 Checks `family_line_links` **first**, then `parents.line_user_id`. Both can only ever name the same family
 * — `family_line_links_user_uq` guarantees one account joins at most one family, and an account that is both a
 * parent row and an invited link is the same person. The order is fixed so the answer is deterministic rather
 * than dependent on which query happened to run.
 */
export async function familyOfLineUser(lineUserId: string, exec: any = db): Promise<string | null> {
  const [link] = await exec
    .select({ parentId: familyLineLinks.parentId })
    .from(familyLineLinks)
    .where(eq(familyLineLinks.lineUserId, lineUserId))
    .limit(1);
  if (link) return link.parentId;
  const parent = await exec.query.parents.findFirst({
    columns: { id: true },
    where: (p: any, { eq: e }: any) => e(p.lineUserId, lineUserId),
  });
  return parent?.id ?? null;
}

/**
 * SPEC-071 Amendment #2 / TASK-232 — bind this chat to a family. **The phone lookup is the binding event.**
 *
 * With the invite cut (REQ-079 §2), the phone is the first inbound message that identifies a family, so this
 * is where `family_line_links` is written.
 *
 * 🔴 **The unique index decides, and this refuses BEFORE it.** A `line_user_id` already bound to family A can
 * never be re-bound to family B — that is the one guarantee which survived all three entry designs, because
 * without it a parent opens the app and sees **another family's children** (TASK-047's failure by a different
 * route). The database would refuse it anyway; refusing here is what turns a `23505` into a sentence a person
 * can act on.
 *
 * Re-binding the SAME family is a no-op, not an error: a parent who types their phone twice has done nothing
 * wrong.
 */
export type FamilyBindResult =
  | { ok: true; alreadyBound: boolean }
  | { ok: false; reason: "bound-to-other-family" };

export async function bindFamilyLine(
  parentId: string,
  lineUserId: string,
  exec: any = db,
): Promise<FamilyBindResult> {
  const current = await familyOfLineUser(lineUserId, exec);
  if (current && current !== parentId) return { ok: false, reason: "bound-to-other-family" };
  await exec
    .insert(familyLineLinks)
    .values({ parentId, lineUserId })
    .onConflictDoNothing();
  return { ok: true, alreadyBound: current === parentId };
}

/**
 * SPEC-071 / TASK-243 — **an admin clears one family's LINE binding.**
 *
 * 🔴 Why this must exist: entry is by phone alone, so the phone lookup binds the chat and
 * `family_line_links_user_uq` makes that binding **permanent from the bot's side** — correctly, because a bot
 * that could unbind itself would make the guarantee protecting every family worth nothing. But the refusal a
 * parent reads says *"this LINE account belongs to another family — contact an admin"*, and until now there was
 * no admin who could do anything about it. The ordinary cases are ordinary: a family changes phone number, a
 * parent typed the wrong one once, a second-hand phone, a guardian leaves the household.
 *
 * 🔴 **This is a deliberate, audited act by staff — not a cleanup.** It is the ONLY way a LINE account can move
 * between families, which is precisely what the unique index exists to stop happening silently. So it takes an
 * `actor` and says so in the log.
 *
 * ⚠️ **Clearing does NOT delete history.** No student, booking, note or message row is touched — the family
 * keeps everything, and the parent can link again from LINE. The tempting mistake is to read "unlink" as
 * "remove the family", and the confirm copy on the screen exists to stop staff making it.
 *
 * 🚫 **No LINE path may reach this.** The bot must not be able to call it — asserted by a grep-guard, the AC-20
 * shape.
 */
export async function clearFamilyLine(
  parentId: string,
  actor: string | null,
  exec?: any,
): Promise<{ cleared: string[] }> {
  const run = async (tx: any): Promise<{ cleared: string[] }> => {
    // Read through the ONE accessor, so "which accounts belong to this family" has a single definition here
    // too — the same rule the binding side uses, rather than a second query that could disagree with it.
    const cleared = await familyLineUserIds(parentId, tx);
    await tx.delete(familyLineLinks).where(eq(familyLineLinks.parentId, parentId));
    // The first link lives on the parent row (TASK-230 kept it there deliberately, so every existing reader is
    // untouched). Clearing one source and not the other is exactly the two-writer disagreement the accessor
    // was built to prevent — so both go, together.
    await tx.update(parents).set({ lineUserId: null }).where(eq(parents.id, parentId));
    return { cleared };
  };

  // 🔴 ATOMIC. The two writes are two halves of one fact, and a failure between them leaves a **half-cleared
  // family** — unbound to the accessor, still holding a stale `line_user_id`. That is precisely the state this
  // function exists to make impossible, so leaving it reachable would have defeated the function's own argument.
  //
  // `exec ? run(exec) : db.transaction(run)` keeps both properties at once: **composable** when a caller already
  // has a transaction (the shape every other writer in this file uses, so a future caller can still fold this
  // into theirs), and **atomic** when nobody supplies one — which is every caller today.
  const result = exec ? await run(exec) : await db.transaction(run);
  // Logged AFTER the write commits, so the trail can never claim something the database refused. (TASK-244 makes
  // this durable; until then it is a log line, and its limits are recorded in TASK-243 §Questions.)
  console.info(
    `[family-link] CLEARED parent=${parentId} accounts=${result.cleared.length} by=${actor ?? "unknown"} ` +
      `— history untouched; the family may link again from LINE.`,
  );
  return result;
}
