// TASK-381 (REQ-092 RBAC, SPEC-079 Stage 2) — the permission KEY registry. Keys are CODE CONSTANTS, never rows
// (SPEC-079 §1): `user_permissions` stores `(user_id, key)` grants against this list. The FE mirrors the list by
// name and both sides pin it. TASK-385 (Stage 3) adds the `action:*` keys HERE; Stage 4's roles bundle the same keys.
//
// 🔴 One menu key per nav entry, in the nav's order (`AdminLayout.config.ts`). `users` is NOT a key: the Users page
// is super-admin-only by `requireSuperAdmin`, not by a grant.

export const MENU_KEYS = [
  "menu:calendar",
  "menu:teachers",
  "menu:people",
  "menu:link-requests",
  "menu:bookings",
  "menu:badges",
  "menu:som",
  "menu:attention",
  "menu:reports",
  "menu:settings",
  "menu:dashboard",
  "menu:overview",
] as const;

export type MenuKey = (typeof MENU_KEYS)[number];
export const isMenuKey = (k: string): k is MenuKey => (MENU_KEYS as readonly string[]).includes(k);

/**
 * The ONE answer to "may this user open this menu?": a super admin may open all; anyone else needs the grant.
 * Several menus ⇒ ANY of them (a shared read serves every page that calls it). Pure.
 */
export const hasMenu = (
  user: { isSuperAdmin: boolean; grants: ReadonlySet<string> } | null | undefined,
  ...menus: readonly MenuKey[]
): boolean => !!user && (user.isSuperAdmin || menus.some((m) => user.grants.has(m)));

/** The menus a user may open — the list `/api/me` hands the FE. A super admin: all of them. */
export const menusOf = (user: { isSuperAdmin: boolean; grants: ReadonlySet<string> }): MenuKey[] =>
  user.isSuperAdmin ? [...MENU_KEYS] : MENU_KEYS.filter((m) => user.grants.has(m));

// ═══════════════════════════ TASK-385 (Stage 3) — the `action:*` keys ═══════════════════════════
//
// 🔴 ONE naming rule (TASK-385 §contract, confirmed): **one key per ACT the owner would tick on a checklist; a route's
// key = its act.** Three consequences, no exceptions: a PREVIEW shares its act's key (a preview a user may see
// but not do is a lie on the screen) · an act and its UNDO share one key (pause/resume, drop/resume,
// suspend/unsuspend, archive/reactivate, approve/reject) · CREATE and EDIT are different acts.
// `area` = the tail of the menu whose page OWNS the entity, carried as a FIELD so the FE groups by it, never by
// parsing. `sales` is the one non-menu area: the discount is a body-level act on four routes across two menus.
//
// Two keys gate a BODY FIELD, not a route (the guard cannot see the body): `action:sales.discount` (the `discount`
// on four creates — `assertMayDiscount`) and `action:calendar.leave-override` (the `override` flag on the status
// route — `assertMayOverrideLeave`). Every other key is on a route in `lib/route-access.ts`.
//
// 🔴 The labels live HERE beside the keys: `GET /permissions` hands this registry to the FE, which has no second
// list of names (the owner's checklist is rendered from it).

import { ApiException } from "./http";

export const ACTION_AREAS = ["calendar", "bookings", "people", "teachers", "link-requests", "badges", "settings", "sales"] as const;
export type ActionArea = (typeof ACTION_AREAS)[number];

export type ActionEntry = { readonly key: `action:${ActionArea}.${string}`; readonly area: ActionArea; readonly labelTh: string; readonly labelEn: string };

const A = <K extends `action:${ActionArea}.${string}`>(key: K, labelTh: string, labelEn: string) =>
  ({ key, area: key.slice("action:".length, key.indexOf(".")) as ActionArea, labelTh, labelEn }) as const;

export const ACTION_REGISTRY = [
  // ── calendar ──
  A("action:calendar.book", "จองคาบเรียน", "Book a session"),
  A("action:calendar.booking-edit", "แก้ไขการจอง", "Edit a booking"),
  A("action:calendar.status", "บันทึกสถานะคาบ (ยืนยัน/มาเรียน/ลาป่วย/ยกเลิก)", "Set a session's status"),
  A("action:calendar.leave-override", "ยกเว้นกฎแจ้งลาล่วงหน้า", "Override the leave-notice rule"), // body-level (the `override` flag)
  A("action:calendar.pause", "พัก/กลับมาเรียน", "Pause & resume a booking"),
  A("action:calendar.badges", "ติดป้ายคาบเรียน", "Set a session's badges"),
  A("action:calendar.note", "บันทึกโน้ตคาบเรียน", "Edit a session's note"),
  A("action:calendar.rental", "บันทึก/รับเงิน/ลบค่าเช่าอุปกรณ์ในคาบ", "Record, pay, remove a session rental"),
  A("action:calendar.rental-sale", "ขายเช่าอุปกรณ์", "Sell a rental"),
  // ── bookings ──
  A("action:bookings.bulk-confirm", "ยืนยันคาบทั้งชุด", "Bulk-confirm sessions"),
  A("action:bookings.course-create", "เปิดคอร์ส", "Create a course"),
  A("action:bookings.course-edit", "แก้ไขคอร์ส", "Edit a course"),
  A("action:bookings.course-plan", "วางแผนคาบของคอร์ส", "Plan a course's sessions"),
  A("action:bookings.course-expiry", "เลื่อนวันหมดอายุคอร์ส", "Change a course's expiry"),
  A("action:bookings.course-extra-session", "เพิ่มคาบพิเศษ", "Add an extra session"),
  A("action:bookings.course-confirm", "ยืนยันคอร์ส", "Confirm a course"),
  A("action:bookings.course-drop", "พัก/กลับมาเรียนคอร์ส", "Drop & resume a course"),
  A("action:bookings.course-cancel", "ยกเลิกคอร์ส", "Cancel a course"),
  A("action:bookings.course-import", "นำเข้าคอร์ส", "Import courses"),
  A("action:bookings.voucher-create", "ออกบัตรกำนัล", "Create a voucher"),
  A("action:bookings.voucher-import", "นำเข้าบัตรกำนัล", "Import vouchers"),
  // ── people ──
  A("action:people.student-create", "เพิ่มนักเรียน", "Add a student"),
  A("action:people.student-edit", "แก้ไขนักเรียน", "Edit a student"),
  A("action:people.student-delete", "ลบนักเรียน", "Delete a student"),
  A("action:people.parent-create", "เพิ่มผู้ปกครอง", "Add a parent"),
  A("action:people.parent-edit", "แก้ไขผู้ปกครอง", "Edit a parent"),
  A("action:people.parent-students", "ผูกนักเรียนกับผู้ปกครอง", "Link a student to a parent"),
  A("action:people.parent-suspend", "ระงับ/ยกเลิกระงับผู้ปกครอง", "Suspend & unsuspend a parent"),
  A("action:people.parent-line-unlink", "ยกเลิกการเชื่อม LINE ผู้ปกครอง", "Clear a parent's LINE link"),
  // ── teachers ──
  A("action:teachers.create", "เพิ่มครู", "Add a teacher"),
  A("action:teachers.edit", "แก้ไขข้อมูลครู", "Edit a teacher"),
  A("action:teachers.archive", "เก็บ/คืนสถานะครู", "Archive & reactivate a teacher"),
  A("action:teachers.budget", "ตั้ง/เติมงบครู", "Set & top up a teacher's budget"),
  A("action:teachers.limit-override", "ปรับเพดานชั่วโมงครู", "Override a teacher's limit"),
  A("action:teachers.work-days", "ตั้งวันทำงานครู", "Set a teacher's work days"),
  A("action:teachers.availability", "ตั้งเวลาว่างครู", "Set teacher availability"),
  A("action:teachers.type-order", "จัดลำดับประเภทครู", "Order teacher types"),
  A("action:teachers.calendar-link", "สร้างลิงก์ปฏิทินครู", "Issue a teacher's calendar link"),
  // ── link requests ──
  A("action:link-requests.decide", "อนุมัติ/ปฏิเสธคำขอเชื่อม LINE", "Approve & reject a LINE link request"),
  A("action:link-requests.unlink", "ยกเลิกการเชื่อม LINE ครู", "Unlink a teacher's LINE"),
  // ── badges ──
  A("action:badges.type-create", "เพิ่มประเภทป้าย", "Add a badge type"),
  A("action:badges.type-edit", "แก้ไขประเภทป้าย", "Edit a badge type"),
  A("action:badges.value-create", "เพิ่มค่าป้าย", "Add a badge value"),
  A("action:badges.value-edit", "แก้ไขค่าป้าย", "Edit a badge value"),
  // ── settings ──
  A("action:settings.edit", "แก้ไขการตั้งค่า", "Edit settings"),
  // ── sales (body-level: the `discount` field on four creates) ──
  A("action:sales.discount", "ให้ส่วนลด", "Give a discount"),
] as const;

export const ACTION_KEYS = ACTION_REGISTRY.map((a) => a.key) as unknown as readonly (typeof ACTION_REGISTRY)[number]["key"][];
export type ActionKey = (typeof ACTION_REGISTRY)[number]["key"];
export const isActionKey = (k: string): k is ActionKey => (ACTION_KEYS as readonly string[]).includes(k);

/** "May this user do this act?" — a super admin may do all; anyone else needs the grant. Pure. */
export const hasAction = (
  user: { isSuperAdmin: boolean; grants: ReadonlySet<string> } | null | undefined,
  action: ActionKey,
): boolean => !!user && (user.isSuperAdmin || user.grants.has(action));

/** The acts a user may do — `/api/me` hands it to the FE beside `menus`. A super admin: all of them. */
export const actionsOf = (user: { isSuperAdmin: boolean; grants: ReadonlySet<string> }): ActionKey[] =>
  user.isSuperAdmin ? [...ACTION_KEYS] : ACTION_KEYS.filter((a) => user.grants.has(a));

/** `GET /permissions` — the registry the FE renders the checklists from. Menus as keys (the nav owns their names). */
export const PERMISSION_REGISTRY = { menus: MENU_KEYS, actions: ACTION_REGISTRY } as const;

/** The action refusal — its OWN sentence, so the FE can tell it from a menu refusal. */
export const ACTION_FORBIDDEN_TH = "ไม่มีสิทธิ์ทำรายการนี้";

/**
 * TASK-385 — the second BODY-level act (the discount is the first, in `discount-plan.ts`): `override: true` on
 * `PATCH /bookings/:id/status` waives the advance-notice leave rule the owner wrote for parents (UC-029). The guard
 * cannot see the body, so the route checks it beside the status change. No flag ⇒ nothing to check.
 */
export function assertMayOverrideLeave(
  override: boolean | undefined,
  user: { isSuperAdmin: boolean; grants: ReadonlySet<string> } | undefined | null,
): void {
  if (!override) return;
  if (!hasAction(user, "action:calendar.leave-override")) throw new ApiException(403, "FORBIDDEN", "ไม่มีสิทธิ์ยกเว้นกฎแจ้งลาล่วงหน้า");
}
