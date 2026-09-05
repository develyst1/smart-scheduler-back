// LINE rich-menu definitions + publish/link helpers (REQ-015 / TASK-038). Two menus by role (the bot detects
// parent vs teacher). Each tap fires a `postback` (`action=…`) routed to the same handler a keyword uses —
// NO QR button (the "qr" command is a redundant text check-in URL; the token plumbing stays untouched).
//
// The menu DEFINITIONS are pure data (unit-tested). The create/upload/link functions call the Messaging API
// (runtime — verify on the real OA). Re-publish with `publishRichMenus({ parentImagePath, teacherImagePath })`
// after supplying two menu images (2500×1686 parent, 2500×843 teacher); it stores the ids in app_settings and
// sets the parent menu as the default. Teachers get the teacher menu linked on account-link.
import { eq } from "drizzle-orm";
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

/**
 * Known (bound) chat: the four things a family does, the language/help pair, and the way to a human.
 *
 * 🔴 TASK-247 — **six cells, not five.** REQ-079's later table (*"`ภาษา` and `ช่วยเหลือ` STAY"*) wins over §12's
 * 3+2 sketch: `action=lang` takes the middle of the bottom row and `คุยกับแอดมิน` narrows to the third-width
 * corner. **The corner is the non-negotiable half; the width was always incidental** — a parent looks for the
 * way to a person in the same place on both menus.
 */
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
    cell(KW, CH, KW, CH, "action=lang"),
    cell(KW * 2, CH, W - KW * 2, CH, "action=admin"),
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

/**
 * TASK-250 — delete ONE rich menu by id. `DELETE /v2/bot/richmenu/{id}`.
 *
 * 🔑 **A 404 is success, not failure**: the end state is what matters, and a removal that refuses to finish
 * because something was already gone is worse than either end state. Returns which of the two it was, so the
 * tool can report *"already absent"* honestly instead of claiming a deletion it did not perform.
 *
 * ⚠️ I could not confirm from the docs, without calling the API, that a missing id is always `404` (it may be
 * `400` for a malformed id). **Both are handled and reported distinctly** rather than guessed at in silence.
 */
export async function deleteRichMenu(richMenuId: string): Promise<"deleted" | "already-gone"> {
  const res = await fetch(`${API}/richmenu/${richMenuId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token()}` },
  });
  if (res.ok) return "deleted";
  if (res.status === 404) return "already-gone";
  throw new Error(`deleteRichMenu ${res.status}: ${await res.text().catch(() => "")}`);
}

/**
 * TASK-250 — cancel the channel-wide default. `DELETE /v2/bot/user/all/richmenu`.
 *
 * After this, a follower with no per-user link sees NO menu at all. That is a product state, not a clean slate,
 * which is why the tool that calls this says so in words.
 */
export async function clearDefaultRichMenu(): Promise<void> {
  const res = await fetch(`${API}/user/all/richmenu`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`clearDefaultRichMenu ${res.status}`);
}

/**
 * TASK-250 — WHICH account this token points at. `GET /v2/bot/info`.
 *
 * 🔴 The token now decides whether a destructive command is about the demo OA or **the customer's**. A tool
 * whose purpose is review must not hide the one fact that makes the review meaningful. Best-effort: an
 * unreadable identity is reported as unknown rather than blocking a read-only dry run.
 */
export async function getBotAccountLabel(): Promise<string> {
  try {
    const res = await fetch(`${API}/info`, { headers: { authorization: `Bearer ${token()}` } });
    if (!res.ok) return `unknown (GET /info → ${res.status})`;
    const b = (await res.json()) as { displayName?: string; basicId?: string; userId?: string };
    return `${b.displayName ?? "?"} (${b.basicId ?? "?"}) userId=${b.userId ?? "?"}`;
  } catch (e) {
    return `unknown (${(e as Error).message})`;
  }
}

/** Set the default menu shown to every follower (used for the parent menu). */
export async function setDefaultRichMenu(richMenuId: string): Promise<void> {
  const res = await fetch(`${API}/user/all/richmenu/${richMenuId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`setDefaultRichMenu ${res.status}`);
}

/**
 * 🔴 TASK-249 (C-13) — remove a chat's PER-USER menu link, so it falls back to the account default.
 *
 * The note above `linkKnownRichMenu` has always said *"a chat whose per-user link is ever removed falls back to
 * ยังไม่รู้จัก"*. **That was true and its premise never happened**: every menu call in this repo was a link, so
 * after an admin cleared a family's LINE binding the parent's phone still showed **menu B — the buttons of an
 * account they no longer have.** This is the caller the comment was describing.
 *
 * ⚠️ Deliberately NOT best-effort in itself — it throws like its siblings — but **every caller treats it as
 * best-effort**: a Messaging-API hiccup must never fail an admin's clear-link, which is a database act.
 */
export async function unlinkRichMenuFromUser(userId: string): Promise<void> {
  const res = await fetch(`${API}/user/${userId}/richmenu`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`unlinkRichMenuFromUser ${res.status}`);
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

/**
 * Upsert menu ids into app_settings (the only write both publish and adopt (TASK-130) need).
 *
 * 🔴 TASK-247 — it **MERGES**. It used to write the whole object, so a partial or repeated publish silently
 * dropped every id it did not create itself: `adopt` (which knows only the four REQ-015 names) would erase the
 * two REQ-079 ids, and vice versa. Same class as every whole-row overwrite this repo has removed.
 *
 * ⚠️ Every field of `MenuIds` is optional, so a naive spread still clobbers — `{ knownTH: undefined }` overwrites
 * a stored id with nothing. **Absent keys are omitted, not written as `undefined`.**
 */
export function mergeMenuIds(current: MenuIds, incoming: MenuIds): MenuIds {
  const merged: MenuIds = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) merged[key as keyof MenuIds] = value as string;
  }
  return merged;
}

/**
 * 🔴 TASK-250 — the ONLY way to REMOVE stored ids, and it deliberately does not go through `storeMenuIds`.
 *
 * ⚠️ **`storeMenuIds({})` is a no-op.** TASK-247 made it merge — for a good reason, so a partial publish cannot
 * erase an id it did not create — and the exact consequence is that *"clear the ids"* written the obvious way
 * would report success and change nothing. A removal tool that leaves the DB pointing at deleted menus is the
 * worst of the three possible outcomes, so the clear is its own function with its own write.
 *
 * `keep` exists because §4's last line matters: **clear only what was actually deleted.** An id whose delete
 * failed must survive — otherwise the surviving menu is stranded with nothing pointing at it and the next run
 * cannot finish the job.
 */
export async function clearMenuIds(keep: MenuIds = {}): Promise<void> {
  const remaining = Object.entries(keep).filter(([, v]) => !!v);
  if (!remaining.length) {
    await db.delete(appSettings).where(eq(appSettings.key, MENU_IDS_KEY));
    return;
  }
  // Written UNMERGED, on purpose: this is the one write whose job is to make ids disappear.
  await db
    .insert(appSettings)
    .values({ key: MENU_IDS_KEY, value: Object.fromEntries(remaining) })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: Object.fromEntries(remaining) } });
}

export async function storeMenuIds(ids: MenuIds): Promise<void> {
  const merged = mergeMenuIds(await getMenuIds(), ids);
  await db
    .insert(appSettings)
    .values({ key: MENU_IDS_KEY, value: merged })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: merged } });
}

/**
 * One-shot (re)publish: create the **six** menus, upload their images, store the ids, and make the
 * **ยังไม่รู้จัก** menu the account default.
 *
 * 🔴 TASK-247 — this function is why REQ-079's menus never reached a phone. It created only the four REQ-015
 * menus, so `UNKNOWN_RICH_MENU` / `KNOWN_RICH_MENU` **were never created on the channel at all**;
 * `linkKnownRichMenu` then found no `knownTH`, and — best-effort by design — did nothing, silently. Supplying
 * artwork alone would have changed nothing and the run would still have reported success.
 *
 * 🔑 And the default is now `unknownTH`. The file's own note says *"ยังไม่รู้จัก is the DEFAULT … a brand-new
 * follower gets the right menu with no code running at all"* — but the only call that sets an account default
 * pointed at the old parent menu. **The design and the code disagreed, and the code is what runs.**
 *
 * ⚠️ TH only, deliberately (SA's call): `*_EN` menus are created only when their images exist. **A stored id
 * with no uploaded image renders BLANK on a phone**, which is worse than falling back to the default.
 */
export async function publishRichMenus(opts: {
  parentThImage: string;
  parentEnImage: string;
  teacherThImage: string;
  teacherEnImage: string;
  unknownThImage: string;
  knownThImage: string;
}): Promise<MenuIds> {
  const parentTH = await createRichMenu(PARENT_RICH_MENU);
  await uploadRichMenuImage(parentTH, opts.parentThImage);
  const parentEN = await createRichMenu(PARENT_RICH_MENU_EN);
  await uploadRichMenuImage(parentEN, opts.parentEnImage);
  const teacherTH = await createRichMenu(TEACHER_RICH_MENU);
  await uploadRichMenuImage(teacherTH, opts.teacherThImage);
  const teacherEN = await createRichMenu(TEACHER_RICH_MENU_EN);
  await uploadRichMenuImage(teacherEN, opts.teacherEnImage);
  // SPEC-071 / REQ-079 — the two menus the runtime has been reading for and never finding.
  const unknownTH = await createRichMenu(UNKNOWN_RICH_MENU);
  await uploadRichMenuImage(unknownTH, opts.unknownThImage);
  const knownTH = await createRichMenu(KNOWN_RICH_MENU);
  await uploadRichMenuImage(knownTH, opts.knownThImage);
  const ids: MenuIds = { parentTH, parentEN, teacherTH, teacherEN, unknownTH, knownTH };
  await storeMenuIds(ids);
  // 🔴 The default is the UNKNOWN menu — the state a chat lands in with no code running. The known menu is the
  // per-user link (`linkKnownRichMenu`), and there is deliberately no unlink: removing the link falls back here.
  await setDefaultRichMenu(unknownTH);
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
