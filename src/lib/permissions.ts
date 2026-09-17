// TASK-381 (REQ-092 RBAC, SPEC-079 Stage 2) — the permission KEY registry. Keys are CODE CONSTANTS, never rows
// (SPEC-079 §1): `user_permissions` stores `(user_id, key)` grants against this list. The FE mirrors the list by
// name and both sides pin it. Stage 3 adds the `action:*` keys HERE; Stage 4's roles bundle the same keys.
//
// 🔴 One key per nav entry, in the nav's order (`AdminLayout.config.ts`). `users` is NOT a key: the Users page is
// super-admin-only by `requireSuperAdmin`, not by a grant.

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

/** The menus a user may open — the list `/auth/me` hands the FE. A super admin: all of them. */
export const menusOf = (user: { isSuperAdmin: boolean; grants: ReadonlySet<string> }): MenuKey[] =>
  user.isSuperAdmin ? [...MENU_KEYS] : MENU_KEYS.filter((m) => user.grants.has(m));
