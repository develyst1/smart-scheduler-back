// 🔴 TASK-538 (owner ruling 09-28) — REMOVE admin rights from a LINE account: the list and the removal. The other half of SEC-1:
// TASK-534 shut the door (no default code, a strength rule, a miss limit); this is how the room is emptied — a credential you
// cannot revoke per person is not a credential.
//
// 🔴 TASK-725 — an admin LINE is now tied to a WEB USER (`users.line_user_id`), so this panel lists TWO kinds of entry:
//   · `linked`  — a web user's LINE account, shown by that user's display name (and whether the user is disabled: a disabled user gets no notices);
//   · `legacy`  — a bare id in `app_settings.line_admin_user_ids`, from before: no name, no user, READ-ONLY (nothing adds to it any more).
// Removing either ends that LINE account's admin rights. A `linked` entry is removed by UNLINKING its user (the web user stays; only the LINE link goes),
// and the legacy copy of the same id, if there is one, goes with it.
//
// 🔑 What removal IS: the ADMIN role taken off one LINE account. Not the person: a coach or a parent behind that account stays one, and falls
// back to THAT menu; anyone else falls back to the account default (the visitor menu). 🚫 The removed account is NEVER told —
// losing a power is staff business, and a message would reach a phone that may be a stranger's (the case that prompted this).
//
// 🔑 What the list can honestly show: a LEGACY id is bare — no LINE display name, no per-link time, no record of who linked or how.
// So each entry names only what OUR data knows (the web user, the coach / the parent behind the id) and the response says what it cannot.
import { createHash } from "node:crypto";
import { db } from "../db";
import { users } from "../db/schema";
import { ApiException } from "../lib/http";
import { getLegacyAdminLineUserIds, removeAdminLineUserId } from "../lib/line-admin";
import { linkRoleRichMenu, unlinkRichMenuFromUser } from "../lib/line-rich-menu";
import { findParentByLineUserId } from "./parent.service";
import { eq } from "drizzle-orm";

/** An opaque, stable handle for one admin link: the FE removes by it, and the full LINE id never has to leave the server. */
export const adminRef = (lineUserId: string): string => createHash("sha256").update(lineUserId).digest("hex").slice(0, 16);

/** The menu the account falls back to — THE order `detectLinkedRole` uses (teacher → parent), minus admin. */
export type AfterRemoval = "teacher-menu" | "parent-menu" | "visitor-menu";

export type LineAdminLink = {
  ref: string;
  /** The last four characters of the LINE id — enough for two rows to be told apart, nothing to act on. */
  idTail: string;
  /** Our own record of who is behind this account, where we have one; null means WE do not know — not that nobody is. */
  alsoTeacher: string | null;
  alsoParent: string | null;
  afterRemoval: AfterRemoval;
  /** TASK-725 — `linked` = a web user's LINE account; `legacy` = a bare id from before. */
  kind: "linked" | "legacy";
  /** TASK-725 — the web user behind a `linked` entry (never the LINE id); null for `legacy`. */
  userId: string | null;
  displayName: string | null;
  username: string | null;
  /** TASK-725 — a disabled user's LINE is still linked but receives NO admin notices. Always false for `legacy`. */
  disabled: boolean;
};

/** 🔑 Said IN the response, so no screen can imply we know these. (Unchanged by TASK-725: it describes what a BARE legacy id reveals.) */
export const NOT_KNOWN = [
  "display name — LINE's name for this account is never stored",
  "linked at — no per-link time is kept (the list's last change is all there is)",
  "how it was linked — a legitimate admin and one who used the old printed code look identical",
] as const;

async function whoIs(lineUserId: string, exec: any) {
  const teacher = await exec.query.teachers.findFirst({ columns: { nickname: true, name: true }, where: (t: any, { eq: e }: any) => e(t.lineUserId, lineUserId) });
  const parent = await findParentByLineUserId(lineUserId, exec);
  const alsoTeacher = teacher ? (teacher.nickname ?? teacher.name ?? null) : null;
  const alsoParent = parent ? (parent.name ?? parent.phone ?? null) : null;
  const afterRemoval: AfterRemoval = teacher ? "teacher-menu" : parent ? "parent-menu" : "visitor-menu";
  return { alsoTeacher, alsoParent, afterRemoval };
}

type LinkedUserRow = { id: string; username: string; displayName: string; lineUserId: string | null; disabledAt: Date | string | null };
/** EVERY web user with a LINE account — disabled ones too: the panel must show them (they receive nothing, but they are still linked). */
async function linkedUsers(exec: any): Promise<Array<LinkedUserRow & { lineUserId: string }>> {
  const rows: LinkedUserRow[] = await exec.query.users.findMany({
    columns: { id: true, username: true, displayName: true, lineUserId: true, disabledAt: true },
    where: (u: any, { isNotNull }: any) => isNotNull(u.lineUserId),
  });
  return rows.filter((r): r is LinkedUserRow & { lineUserId: string } => !!r.lineUserId);
}

export async function listLineAdmins(exec: any = db): Promise<{ admins: LineAdminLink[]; notKnown: typeof NOT_KNOWN }> {
  const linked = await linkedUsers(exec);
  const linkedIds = new Set(linked.map((u) => u.lineUserId));
  const admins: LineAdminLink[] = [];
  for (const u of linked) {
    admins.push({ ref: adminRef(u.lineUserId), idTail: `…${u.lineUserId.slice(-4)}`, ...(await whoIs(u.lineUserId, exec)), kind: "linked", userId: u.id, displayName: u.displayName, username: u.username, disabled: !!u.disabledAt });
  }
  // A legacy id that is ALSO a linked user's account is the same LINE account: it is shown once, as `linked`.
  for (const id of await getLegacyAdminLineUserIds(exec)) {
    if (linkedIds.has(id)) continue;
    admins.push({ ref: adminRef(id), idTail: `…${id.slice(-4)}`, ...(await whoIs(id, exec)), kind: "legacy", userId: null, displayName: null, username: null, disabled: false });
  }
  return { admins, notKnown: NOT_KNOWN };
}

/**
 * The menu the account falls back to, best-effort: the role menu if a coach/parent is behind the account, else the per-user link is removed so the account
 * default (the visitor menu) applies. A failed menu call is reported (`menuSettled: false`) and logged, never a failed removal. 🚫 No message to the account.
 * TASK-725: the ONE place that does this, shared by the panel's removal, the Unlink, and a re-link that replaces a user's earlier LINE account.
 */
export async function settleMenuAfterRemoval(id: string, exec: any = db): Promise<{ afterRemoval: AfterRemoval; menuSettled: boolean }> {
  const { afterRemoval } = await whoIs(id, exec);
  let menuSettled = true;
  try {
    if (afterRemoval === "teacher-menu") await linkRoleRichMenu(id, "teacher");
    else if (afterRemoval === "parent-menu") await linkRoleRichMenu(id, "customer");
    else await unlinkRichMenuFromUser(id);
  } catch (e) {
    menuSettled = false;
    console.error(`🔴 [TASK-538] admin link …${id.slice(-4)} REMOVED, but its menu could not be moved (${afterRemoval}): ${(e as Error).message}. It keeps the admin menu's one cell (the web login) until the relink sweep or the next link.`);
  }
  return { afterRemoval, menuSettled };
}

/**
 * 🔴 TASK-725 — UNLINK a web user's LINE account (super admin). The write comes FIRST: `line_user_id` and any pending link code are cleared, and from that
 * moment the account is no longer a recipient or an admin (`detectLinkedRole` and `notifyAdmins` read `getAdminLineUserIds`). The LEGACY copy of the same
 * id, if it is also on that list, goes too — "this LINE account is no longer an admin" must be true, not half true. Then the menu, best-effort.
 * Idempotent: a user with nothing linked ⇒ nothing written, `afterRemoval: "none"`. 🚫 The unlinked account is NEVER told.
 */
export async function unlinkLineOfUser(userId: string, actor: string | null, exec: any = db): Promise<{ lineUserId: string | null; afterRemoval: AfterRemoval | "none"; menuSettled: boolean }> {
  const row = await exec.query.users.findFirst({ columns: { id: true, lineUserId: true }, where: (u: any, { eq: e }: any) => e(u.id, userId) });
  if (!row) throw new ApiException(404, "NOT_FOUND", "ไม่พบผู้ใช้");
  const id: string | null = row.lineUserId ?? null;
  if (!id) return { lineUserId: null, afterRemoval: "none", menuSettled: true };
  await exec.update(users).set({ lineUserId: null, lineLinkCodeHash: null, lineLinkCodeExpiresAt: null }).where(eq(users.id, userId));
  await removeAdminLineUserId(id, exec);
  const settled = await settleMenuAfterRemoval(id, exec);
  console.info(`[TASK-725] LINE …${id.slice(-4)} unlinked from user ${userId} by ${actor ?? "unknown"} → ${settled.afterRemoval}`);
  return { lineUserId: id, ...settled };
}

/** Take the admin role off ONE LINE account, by its opaque ref: a `linked` entry unlinks its user; a `legacy` one leaves the old list. */
export async function removeLineAdmin(ref: string, actor: string | null, exec: any = db) {
  // The ref's SHAPE first (the route declares it free-form, TASK-463's rule): anything that is not one of ours is simply not found.
  const shaped = /^[0-9a-f]{16}$/.test(ref);
  const owner = shaped ? (await linkedUsers(exec)).find((u) => adminRef(u.lineUserId) === ref) : undefined;
  if (owner) {
    const r = await unlinkLineOfUser(owner.id, actor, exec);
    return { removed: { ref, idTail: `…${owner.lineUserId.slice(-4)}` }, afterRemoval: r.afterRemoval as AfterRemoval, menuSettled: r.menuSettled };
  }
  const id = shaped ? (await getLegacyAdminLineUserIds(exec)).find((x) => adminRef(x) === ref) : undefined;
  if (!id) throw new ApiException(404, "NOT_FOUND", "ไม่พบบัญชี LINE แอดมินนี้");
  await removeAdminLineUserId(id, exec);
  const { afterRemoval, menuSettled } = await settleMenuAfterRemoval(id, exec);
  console.info(`[TASK-538] LINE admin link …${id.slice(-4)} removed by ${actor ?? "unknown"} → ${afterRemoval}`);
  return { removed: { ref, idTail: `…${id.slice(-4)}` }, afterRemoval, menuSettled };
}
