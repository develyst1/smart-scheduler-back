// LINE rich-menu definitions + publish/link helpers (REQ-015 / TASK-038). Two menus by role (the bot detects
// parent vs teacher). Each tap fires a `postback` (`action=…`) routed to the same handler a keyword uses —
// NO QR button (the "qr" command is a redundant text check-in URL; the token plumbing stays untouched).
//
// The menu DEFINITIONS are pure data (unit-tested). The create/upload/link functions call the Messaging API
// (runtime — verify on the real OA). Re-publish with `publishRichMenus({ parentImagePath, teacherImagePath })`
// after supplying two menu images (2500×1686 parent, 2500×843 teacher); it stores the ids in app_settings and
// sets the parent menu as the default. Teachers get the teacher menu linked on account-link.
import { db } from "../db";
import { appSettings } from "../db/schema";
import type { Lang } from "./line-i18n";

export interface RichMenuArea {
  bounds: { x: number; y: number; width: number; height: number };
  action: { type: "postback"; data: string; label?: string };
}
export interface RichMenuDef {
  size: { width: number; height: number };
  selected: boolean;
  name: string;
  chatBarText: string;
  areas: RichMenuArea[];
}

const cell = (x: number, y: number, w: number, h: number, data: string): RichMenuArea => ({
  bounds: { x, y, width: w, height: h },
  action: { type: "postback", data },
});

// Parent: 3×2 grid on 2500×1686 (six 833×843 cells). check-in · leave · my children / register · lang · help.
const W = 2500;
const H = 1686;
const CW = Math.floor(W / 3); // 833
const CH = H / 2; // 843
export const PARENT_RICH_MENU: RichMenuDef = {
  size: { width: W, height: H },
  selected: true,
  name: "smart-scheduler-parent-th",
  chatBarText: "เมนู",
  areas: [
    cell(0, 0, CW, CH, "action=checkin"),
    cell(CW, 0, CW, CH, "action=leave"),
    cell(CW * 2, 0, W - CW * 2, CH, "action=children"),
    cell(0, CH, CW, CH, "action=register"),
    cell(CW, CH, CW, CH, "action=lang"),
    cell(CW * 2, CH, W - CW * 2, CH, "action=help"),
  ],
};

// Teacher: 2 cells on a compact 2500×843 bar. my schedule (REQ-016 slot) · language/help.
export const TEACHER_RICH_MENU: RichMenuDef = {
  size: { width: W, height: 843 },
  selected: false,
  name: "smart-scheduler-teacher-th",
  chatBarText: "เมนู",
  areas: [
    cell(0, 0, W / 2, 843, "action=schedule"),
    cell(W / 2, 0, W / 2, 843, "action=lang"),
  ],
};

// ─────────── SPEC-071 / TASK-234 (REQ-079) — the two menu SETS: ยังไม่รู้จัก and รู้จักแล้ว ───────────
//
// 📌 The cheapest shape, from SPEC-071 §Overview: **ยังไม่รู้จัก is the DEFAULT menu** and **รู้จักแล้ว is the
// per-user link.** A brand-new follower then gets the right menu with **no code running at all**, and
// "unknown" is the state you fall back to rather than one somebody must remember to set. Same publish/link
// mechanism as REQ-042 — zero new machinery, only new data.
//
// 🔴 **`คุยกับแอดมิน` is on BOTH menus, always, and no flow may remove it.** It is the promise that a person is
// reachable, and it is the only thing that makes a bot acceptable to a parent — **a lockout or a handover must
// never be a dead end.** `menuHasAdminButton` below asserts it for every menu in this file.
//
// ⚠️ `เข้าใช้ระบบ` now leads to "ask an admin", NOT to a code prompt: Flow 2 was deleted in §15.

/** Unknown chat: two big cells on the compact bar. */
export const UNKNOWN_RICH_MENU: RichMenuDef = {
  size: { width: W, height: 843 },
  selected: true, // the DEFAULT — see the note above
  name: "smart-scheduler-unknown-th",
  chatBarText: "เมนู",
  areas: [
    cell(0, 0, W / 2, 843, "action=enter"),
    cell(W / 2, 0, W / 2, 843, "action=admin"),
  ],
};

/** Known (bound) chat: the four things a family does, plus the way to a human. */
const KW = Math.floor(W / 3);
export const KNOWN_RICH_MENU: RichMenuDef = {
  size: { width: W, height: H },
  selected: false,
  name: "smart-scheduler-known-th",
  chatBarText: "เมนู",
  areas: [
    cell(0, 0, KW, CH, "action=leave"),
    cell(KW, 0, KW, CH, "action=checkin"),
    cell(KW * 2, 0, W - KW * 2, CH, "action=mycourses"),
    cell(0, CH, KW, CH, "action=register"),
    cell(KW, CH, W - KW, CH, "action=admin"),
  ],
};

export const UNKNOWN_RICH_MENU_EN: RichMenuDef = { ...UNKNOWN_RICH_MENU, name: "smart-scheduler-unknown-en", chatBarText: "Menu", selected: false };
export const KNOWN_RICH_MENU_EN: RichMenuDef = { ...KNOWN_RICH_MENU, name: "smart-scheduler-known-en", chatBarText: "Menu" };

/** 🔴 The invariant, as a function so it can be asserted rather than remembered. */
export const menuHasAdminButton = (m: RichMenuDef): boolean =>
  m.areas.some((a) => a.action.data === "action=admin");

// English variants — same tap areas/actions (postback keys are language-neutral); only the image + labels
// differ. The EN menu image carries the English text (supplied at publish time).
export const PARENT_RICH_MENU_EN: RichMenuDef = {
  ...PARENT_RICH_MENU,
  name: "smart-scheduler-parent-en",
  chatBarText: "Menu",
  selected: false,
};
export const TEACHER_RICH_MENU_EN: RichMenuDef = {
  ...TEACHER_RICH_MENU,
  name: "smart-scheduler-teacher-en",
  chatBarText: "Menu",
};

const API = "https://api.line.me/v2/bot";
const API_DATA = "https://api-data.line.me/v2/bot";
const MENU_IDS_KEY = "line_rich_menu_ids";

function token(): string {
  const t = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!t) throw new Error("LINE_CHANNEL_ACCESS_TOKEN not set");
  return t;
}

/** Create a rich menu → returns its richMenuId. */
export async function createRichMenu(menu: RichMenuDef): Promise<string> {
  const res = await fetch(`${API}/richmenu`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
    body: JSON.stringify(menu),
  });
  if (!res.ok) throw new Error(`createRichMenu ${res.status}: ${await res.text().catch(() => "")}`);
  return ((await res.json()) as { richMenuId: string }).richMenuId;
}

/** Upload the menu image (2500-wide JPEG/PNG). Image host is api-data, not api. */
export async function uploadRichMenuImage(richMenuId: string, imagePath: string): Promise<void> {
  const file = Bun.file(imagePath);
  const contentType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";
  const res = await fetch(`${API_DATA}/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { "content-type": contentType, authorization: `Bearer ${token()}` },
    body: await file.arrayBuffer(),
  });
  if (!res.ok) throw new Error(`uploadRichMenuImage ${res.status}: ${await res.text().catch(() => "")}`);
}

/** Set the default menu shown to every follower (used for the parent menu). */
export async function setDefaultRichMenu(richMenuId: string): Promise<void> {
  const res = await fetch(`${API}/user/all/richmenu/${richMenuId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`setDefaultRichMenu ${res.status}`);
}

/** Link a menu to one user (used to give a teacher the teacher menu on account-link). */
export async function linkRichMenuToUser(userId: string, richMenuId: string): Promise<void> {
  const res = await fetch(`${API}/user/${userId}/richmenu/${richMenuId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`linkRichMenuToUser ${res.status}`);
}

export type MenuIds = {
  parentTH?: string;
  parentEN?: string;
  teacherTH?: string;
  teacherEN?: string;
  // TASK-234 — REQ-079's two sets. Stored beside the others in the SAME app_settings row, so publishing
  // and adopting stay one mechanism (REQ-042 / TASK-130), not two that can disagree about which ids exist.
  unknownTH?: string;
  unknownEN?: string;
  knownTH?: string;
  knownEN?: string;
};

export async function getMenuIds(): Promise<MenuIds> {
  const row = await db.query.appSettings.findFirst({
    where: (s, { eq }) => eq(s.key, MENU_IDS_KEY),
  });
  const v = row?.value;
  return v && typeof v === "object" ? (v as MenuIds) : {};
}

/** Upsert the four ids into app_settings (the only write both publish and adopt (TASK-130) need). */
export async function storeMenuIds(ids: MenuIds): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: MENU_IDS_KEY, value: ids })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: ids } });
}

/** One-shot (re)publish: create all four menus (parent/teacher × TH/EN), upload images, store the ids,
 *  set the Thai parent menu as the default. Supply four 2500-wide images (parent 2500×1686, teacher 2500×843). */
export async function publishRichMenus(opts: {
  parentThImage: string;
  parentEnImage: string;
  teacherThImage: string;
  teacherEnImage: string;
}): Promise<MenuIds> {
  const parentTH = await createRichMenu(PARENT_RICH_MENU);
  await uploadRichMenuImage(parentTH, opts.parentThImage);
  const parentEN = await createRichMenu(PARENT_RICH_MENU_EN);
  await uploadRichMenuImage(parentEN, opts.parentEnImage);
  const teacherTH = await createRichMenu(TEACHER_RICH_MENU);
  await uploadRichMenuImage(teacherTH, opts.teacherThImage);
  const teacherEN = await createRichMenu(TEACHER_RICH_MENU_EN);
  await uploadRichMenuImage(teacherEN, opts.teacherEnImage);
  const ids: MenuIds = { parentTH, parentEN, teacherTH, teacherEN };
  await storeMenuIds(ids);
  await setDefaultRichMenu(parentTH); // TH parent menu is the default; EN/teacher menus link per user
  return ids;
}

// ── Read-only inspection (TASK-045 diagnostics — these NEVER create/link/delete anything) ──────────────

/** GET /v2/bot/richmenu/{id} — the menu as LINE actually stores it (incl. its `areas`). null on 404/error. */
export async function getRichMenu(richMenuId: string): Promise<any | null> {
  const res = await fetch(`${API}/richmenu/${richMenuId}`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) return null;
  return res.json();
}

/** GET /v2/bot/richmenu/list — every menu on the channel, incl. any created outside our publish (OA Manager). */
export async function listRichMenus(): Promise<any[]> {
  const res = await fetch(`${API}/richmenu/list`, { headers: { authorization: `Bearer ${token()}` } });
  if (!res.ok) return [];
  const body = (await res.json()) as { richmenus?: any[] };
  return body.richmenus ?? [];
}

/** GET /v2/bot/user/all/richmenu — the channel-wide default menu id (null if none is set). */
export async function getDefaultRichMenuId(): Promise<string | null> {
  const res = await fetch(`${API}/user/all/richmenu`, { headers: { authorization: `Bearer ${token()}` } });
  if (!res.ok) return null;
  const body = (await res.json()) as { richMenuId?: string };
  return body.richMenuId ?? null;
}

/** GET /v2/bot/user/{userId}/richmenu — the menu THIS user actually has linked (null = none → they see the
 *  default). A per-user link from an earlier publish overrides the default, which is hypothesis (B). */
export async function getUserRichMenuId(userId: string): Promise<string | null> {
  const res = await fetch(`${API}/user/${userId}/richmenu`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { richMenuId?: string };
  return body.richMenuId ?? null;
}

/** Best-effort: link the menu matching the user's role + language (called on account-link and on toggle). */
/**
 * SPEC-071 / TASK-234 — give a BOUND chat the รู้จักแล้ว menu.
 *
 * 🔴 There is no matching "unlink" call, on purpose: **ยังไม่รู้จัก is the DEFAULT menu**, so a chat that was
 * never linked — or whose per-user link is ever removed — falls back to it with no code running. "Unknown" is
 * the state you land in, not one anybody has to remember to set.
 *
 * Best-effort, like : a menu that has not been published yet leaves the chat on the default,
 * which is the correct menu for a chat we cannot yet serve.
 */
export async function linkKnownRichMenu(userId: string, lang: Lang = "TH"): Promise<void> {
  const ids = await getMenuIds();
  const target = lang === "EN" ? ids.knownEN : ids.knownTH;
  if (target) await linkRichMenuToUser(userId, target);
}

export async function linkRoleRichMenu(
  userId: string,
  role: "customer" | "teacher",
  lang: Lang = "TH",
): Promise<void> {
  const ids = await getMenuIds();
  const key = (role === "teacher" ? "teacher" : "parent") + (lang === "EN" ? "EN" : "TH");
  const target = ids[key as keyof MenuIds];
  if (target) await linkRichMenuToUser(userId, target);
}
