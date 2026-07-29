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

type MenuIds = { parentTH?: string; parentEN?: string; teacherTH?: string; teacherEN?: string };

async function getMenuIds(): Promise<MenuIds> {
  const row = await db.query.appSettings.findFirst({
    where: (s, { eq }) => eq(s.key, MENU_IDS_KEY),
  });
  const v = row?.value;
  return v && typeof v === "object" ? (v as MenuIds) : {};
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
  await db
    .insert(appSettings)
    .values({ key: MENU_IDS_KEY, value: ids })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: ids } });
  await setDefaultRichMenu(parentTH); // TH parent menu is the default; EN/teacher menus link per user
  return ids;
}

/** Best-effort: link the menu matching the user's role + language (called on account-link and on toggle). */
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
