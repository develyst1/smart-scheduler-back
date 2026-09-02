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
import { familyLineLinks } from "../db/schema";

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
