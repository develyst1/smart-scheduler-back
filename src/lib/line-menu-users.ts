// TASK-446 — the sweep's IMPURE half: every LINE account this system knows, with the role and language the menu rules read.
// Teachers first, so a coach who is also a parent keeps the teacher menu (`dedupeMenuUsers`).
//
// The tables that hold a `line_user_id`: `teachers` (+ `line_lang`) · `parents` (the DISPLAY primary, + `line_lang`) ·
// `family_line_links` (the ROUTING set — a family may link several phones; the language is the parent's) · `students` (a
// backoffice target, never menu-linked) · `line_link_sessions` / `teacher_link_requests` (mid-link, not yet a known user —
// they correctly sit on the channel default). The last three are deliberately NOT swept.
import { db } from "../db";
import { familyLineLinks, parents, teachers } from "../db/schema";
import { dedupeMenuUsers, type MenuLang, type MenuUser } from "./line-relink-plan";

const langOf = (v: unknown): MenuLang => (v === "EN" ? "EN" : "TH");

/** Every known account, deduplicated, without their live link (the script fills `linkedMenuId` from the API). */
export async function listMenuUsers(exec: any = db): Promise<MenuUser[]> {
  const teacherRows = await exec.query.teachers.findMany({ columns: { id: true, name: true, nickname: true, lineUserId: true, lineLang: true, archived: true } });
  const parentRows = await exec.query.parents.findMany({ columns: { id: true, name: true, phone: true, lineUserId: true, lineLang: true } });
  const linkRows = await exec.select({ parentId: familyLineLinks.parentId, lineUserId: familyLineLinks.lineUserId }).from(familyLineLinks);
  const parentById = new Map<string, any>(parentRows.map((p: any) => [p.id, p]));
  const users: MenuUser[] = [
    ...teacherRows.filter((t: any) => t.lineUserId && !t.archived).map((t: any) => ({ lineUserId: t.lineUserId as string, name: t.nickname ?? t.name ?? "(teacher)", role: "teacher" as const, lang: langOf(t.lineLang), linkedMenuId: null })),
    ...parentRows.filter((p: any) => p.lineUserId).map((p: any) => ({ lineUserId: p.lineUserId as string, name: p.name ?? p.phone ?? "(parent)", role: "customer" as const, lang: langOf(p.lineLang), linkedMenuId: null })),
    ...linkRows.filter((l: any) => l.lineUserId).map((l: any) => { const p = parentById.get(l.parentId); return { lineUserId: l.lineUserId as string, name: p?.name ?? p?.phone ?? "(family)", role: "customer" as const, lang: langOf(p?.lineLang), linkedMenuId: null }; }),
  ];
  return dedupeMenuUsers(users);
}

/** How many accounts a publish leaves holding an old per-user link — the number the warning names. */
export async function countMenuUsers(exec: any = db): Promise<number> {
  return (await listMenuUsers(exec)).length;
}
