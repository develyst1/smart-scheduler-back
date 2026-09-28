// 🔴 TASK-538 (owner ruling 09-28) — REMOVE admin rights from a LINE account: the list and the removal. The other half of SEC-1:
// TASK-534 shut the door (no default code, a strength rule, a miss limit); this is how the room is emptied — a credential you
// cannot revoke per person is not a credential.
//
// 🔑 What removal IS: the ADMIN role taken off one LINE account (its id out of `app_settings.line_admin_user_ids`, which is the only
// thing `notifyAdmins` and `detectLinkedRole` read). Not the person: a coach or a parent behind that account stays one, and falls
// back to THAT menu; anyone else falls back to the account default (the visitor menu). 🚫 The removed account is NEVER told —
// losing a power is staff business, and a message would reach a phone that may be a stranger's (the case that prompted this).
//
// 🔑 What the list can honestly show: we keep BARE ids — no LINE display name, no per-link time, no record of who linked or how.
// So each entry names only what OUR data knows (the coach / the parent behind the id) and the response says what it cannot.
import { createHash } from "node:crypto";
import { db } from "../db";
import { ApiException } from "../lib/http";
import { getAdminLineUserIds, removeAdminLineUserId } from "../lib/line-admin";
import { linkRoleRichMenu, unlinkRichMenuFromUser } from "../lib/line-rich-menu";
import { findParentByLineUserId } from "./parent.service";

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
};

/** 🔑 Said IN the response, so no screen can imply we know these. */
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

export async function listLineAdmins(exec: any = db): Promise<{ admins: LineAdminLink[]; notKnown: typeof NOT_KNOWN }> {
  const ids = await getAdminLineUserIds(exec);
  const admins: LineAdminLink[] = [];
  for (const id of ids) admins.push({ ref: adminRef(id), idTail: `…${id.slice(-4)}`, ...(await whoIs(id, exec)) });
  return { admins, notKnown: NOT_KNOWN };
}

/**
 * Take the admin role off ONE account. The list write comes FIRST: from that moment `notifyAdmins` no longer reaches it (the part
 * that matters), whatever LINE does next. Then the menu, best-effort: the role menu if a coach/parent is behind the account, else the
 * per-user link is removed so the account default (the visitor menu) applies. A failed menu call is reported (`menuSettled: false`)
 * and logged, never a failed removal. 🚫 No message to the account.
 */
export async function removeLineAdmin(ref: string, actor: string | null, exec: any = db) {
  // The ref's SHAPE first (the route declares it free-form, TASK-463's rule): anything that is not one of ours is simply not found.
  const id = /^[0-9a-f]{16}$/.test(ref) ? (await getAdminLineUserIds(exec)).find((x) => adminRef(x) === ref) : undefined;
  if (!id) throw new ApiException(404, "NOT_FOUND", "ไม่พบบัญชี LINE แอดมินนี้");
  await removeAdminLineUserId(id, exec);
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
  console.info(`[TASK-538] LINE admin link …${id.slice(-4)} removed by ${actor ?? "unknown"} → ${afterRemoval}`);
  return { removed: { ref, idTail: `…${id.slice(-4)}` }, afterRemoval, menuSettled };
}
