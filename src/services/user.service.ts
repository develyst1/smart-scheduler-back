// TASK-377 (REQ-092 RBAC, SPEC-079 Stage 1) — real users. The ONE shared env login became a table: passwords
// are `Bun.password` (argon2id, built in), the guard reads the row on every request, and every audit `actor`
// is a real username. Super admins manage users; the LAST enabled super admin cannot be disabled or demoted.
//
// 🔴 `password_hash` never leaves this file: every reader goes through `toUserDTO`, which picks columns. A
// service that returned a row would leak the hash into the first `c.json(row)` somebody wrote.

import { and, asc, eq, inArray, isNull, like, ne, sql } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { db } from "../db";
import { rolePermissions, userPermissions, users } from "../db/schema";
import { findRole, roleKeysByIds } from "./role.service";
import { ACTION_KEYS, MENU_KEYS, isActionKey, isMenuKey, type ActionKey, type MenuKey } from "../lib/permissions";
import { ApiException, conflict, notFound, pgErrorCode } from "../lib/http";

export const PASSWORD_MIN = 8;
export const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;

/** Trimmed + lower-cased — the login key is case-insensitive by construction, never by a second query. */
export const normalizeUsername = (u: string): string => u.trim().toLowerCase();

export type UserDTO = {
  id: string;
  username: string;
  displayName: string;
  isSuperAdmin: boolean;
  disabledAt: string | null;
  createdAt: string;
  /** TASK-381 — the user's `menu:*` grants (a super admin: all of them). */
  menus: MenuKey[];
  /** TASK-385 — the user's `action:*` grants (a super admin: all of them). 🔻 TASK-387: EFFECTIVE (role ∪ own). */
  actions: ActionKey[];
  /** TASK-387 — the LIVE role (null = none) and the split the checklists show: inherited vs own. */
  roleId: string | null;
  roleName: string | null;
  grants: { fromRole: string[]; own: string[] };
};

/** What `toUserDTO` needs of a role: its id, name and keys. */
export type RoleGrants = { id: string; name: string; keys: readonly string[] };

export const toUserDTO = (u: {
  id: string;
  username: string;
  displayName: string;
  isSuperAdmin: boolean;
  disabledAt: Date | string | null;
  createdAt: Date | string;
}, own: Iterable<string> = [], role: RoleGrants | null = null): UserDTO => {
  // 🔴 TASK-387: `menus`/`actions` are EFFECTIVE = the role's keys ∪ the user's own rows (a super admin: all).
  const ownKeys = [...own];
  const effective = new Set([...(role?.keys ?? []), ...ownKeys]);
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    isSuperAdmin: u.isSuperAdmin,
    disabledAt: u.disabledAt ? new Date(u.disabledAt).toISOString() : null,
    createdAt: new Date(u.createdAt).toISOString(),
    menus: u.isSuperAdmin ? [...MENU_KEYS] : MENU_KEYS.filter((m) => effective.has(m)),
    actions: u.isSuperAdmin ? [...ACTION_KEYS] : ACTION_KEYS.filter((a) => effective.has(a)),
    roleId: role?.id ?? null,
    roleName: role?.name ?? null,
    grants: { fromRole: [...(role?.keys ?? [])], own: ownKeys },
  };
};

export const hashPassword = (password: string) => Bun.password.hash(password);
export const verifyPassword = (password: string, hash: string) => Bun.password.verify(password, hash);

export function assertPassword(password: string) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) {
    throw new ApiException(400, "PASSWORD_TOO_SHORT", `รหัสผ่านต้องยาวอย่างน้อย ${PASSWORD_MIN} ตัวอักษร`);
  }
}

/** The guard's per-request read: by primary key, one indexed lookup. `null` when the row is gone. */
export async function findUserById(id: string, exec: any = db) {
  return (await exec.query.users.findFirst({ where: (u: any, { eq: e }: any) => e(u.id, id) })) ?? null;
}

export async function findUserByUsername(username: string, exec: any = db) {
  return (await exec.query.users.findFirst({ where: (u: any, { eq: e }: any) => e(u.username, normalizeUsername(username)) })) ?? null;
}

export async function countUsers(exec: any = db): Promise<number> {
  const [row] = await exec.select({ n: sql<number>`count(*)::int` }).from(users);
  return Number(row?.n ?? 0);
}

/** TASK-381 — this user's OWN grant keys, one indexed query (the DTO's `grants.own`; the replace-writers). */
export async function userGrantKeys(userId: string, exec: any = db): Promise<string[]> {
  const rows = await exec.select({ key: userPermissions.key }).from(userPermissions).where(eq(userPermissions.userId, userId));
  return rows.map((r: any) => r.key as string);
}

/**
 * 🔴 TASK-387 — the guard's second read, EFFECTIVE: the user's own rows UNION their role's rows, ONE statement
 * (both halves index-backed; UNION dedupes). The guard already holds the row, so `roleId` costs nothing; with no
 * role it is the own-rows read alone. A super admin skips this entirely (the guard's rule, unchanged).
 */
export async function effectiveGrantKeys(userId: string, roleId: string | null | undefined, exec: any = db): Promise<string[]> {
  const own = exec.select({ key: userPermissions.key }).from(userPermissions).where(eq(userPermissions.userId, userId));
  const rows = roleId
    ? await union(own, exec.select({ key: rolePermissions.key }).from(rolePermissions).where(eq(rolePermissions.roleId, roleId)))
    : await own;
  return rows.map((r: any) => r.key as string);
}

/** The DTO of one row: its own rows + its role (two small reads; the list uses the grouped readers instead). */
export async function userDTO(row: { id: string; username: string; displayName: string; isSuperAdmin: boolean; disabledAt: Date | string | null; createdAt: Date | string; roleId?: string | null }): Promise<UserDTO> {
  const [own, role] = await Promise.all([userGrantKeys(row.id), roleGrantsOf(row.roleId)]);
  return toUserDTO(row, own, role);
}

export async function roleGrantsOf(roleId: string | null | undefined): Promise<RoleGrants | null> {
  if (!roleId) return null;
  const role = await findRole(roleId);
  if (!role) return null;
  return { id: role.id, name: role.name, keys: (await roleKeysByIds([roleId])).get(roleId) ?? [] };
}

async function grantsByUser(userIds: string[], exec: any = db): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (userIds.length === 0) return out;
  const rows = await exec.select({ userId: userPermissions.userId, key: userPermissions.key }).from(userPermissions).where(inArray(userPermissions.userId, userIds));
  for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), r.key]);
  return out;
}

/** THREE reads for the whole list (users with their role · own rows grouped · the listed roles' keys grouped), never per user. */
export async function listUsers() {
  const rows = await db.query.users.findMany({ orderBy: (u, { asc: a }) => [a(u.username)], with: { role: true } });
  const roleIds = [...new Set(rows.map((r) => r.roleId).filter((x): x is string => !!x))];
  const [grants, roleKeys] = await Promise.all([grantsByUser(rows.map((r) => r.id)), roleKeysByIds(roleIds)]); // grouped reads, not one per user
  return rows.map((r) => toUserDTO(r, grants.get(r.id) ?? [], r.role ? { id: r.role.id, name: r.role.name, keys: roleKeys.get(r.role.id) ?? [] } : null));
}

/**
 * TASK-387 — assign (or detach, `null`) the LIVE role. The user's OWN rows are untouched (additive — SPEC-079
 * §3.4; the owner's list carries the "assigning clears own ticks" alternative). A super-admin target is accepted
 * and stored (meaningless while super; the role a later demotion lands on). Unknown role ⇒ 404.
 */
export async function setUserRole(id: string, roleId: string | null): Promise<UserDTO> {
  await mustFind(id);
  if (roleId !== null && !(await findRole(roleId))) throw notFound("ไม่พบบทบาท");
  await db.update(users).set({ roleId }).where(eq(users.id, id));
  return userDTO(await mustFind(id));
}

/**
 * TASK-381 — REPLACE a user's `menu:*` grants with `keys` (unknown key ⇒ 400; duplicates collapse). A super-admin
 * target is accepted and stored — meaningless while super, and the set a later demotion lands on. One
 * transaction: delete the menu rows, insert the new ones.
 */
export async function setUserMenus(id: string, keys: string[], actor: string | null): Promise<UserDTO> {
  return replaceGrants(id, keys, "menu:", isMenuKey, "ไม่รู้จักเมนู", actor);
}

/** TASK-385 — the mirror for `action:*`: replace the user's acts; unknown key ⇒ 400 before any write. */
export async function setUserActions(id: string, keys: string[], actor: string | null): Promise<UserDTO> {
  return replaceGrants(id, keys, "action:", isActionKey, "ไม่รู้จักรายการ", actor);
}

/**
 * The ONE replace: refuse an unknown key BEFORE the transaction; one tx deletes the user's rows of this PREFIX and
 * inserts the deduplicated set. The other prefix's rows are untouched — menus and actions are independent grants
 * (SPEC-079 §3.4: "see the menu, change nothing" is a valid combination).
 */
async function replaceGrants(id: string, keys: string[], prefix: "menu:" | "action:", isKey: (k: string) => boolean, unknownWord: string, actor: string | null): Promise<UserDTO> {
  const row = await mustFind(id);
  const bad = keys.filter((k) => !isKey(k));
  if (bad.length) throw new ApiException(400, "VALIDATION", `${unknownWord}: ${bad.join(", ")}`);
  const set = [...new Set(keys)];
  await db.transaction(async (tx) => {
    await tx.delete(userPermissions).where(and(eq(userPermissions.userId, id), like(userPermissions.key, `${prefix}%`)));
    if (set.length) await tx.insert(userPermissions).values(set.map((key) => ({ userId: id, key, grantedBy: actor })));
  });
  return userDTO(row); // 🚫 the role is never touched by these writers — own rows only
}

/** TASK-381 — any user changes their OWN password: the current one must verify (400 WRONG_PASSWORD), the new one min 8 (400). */
export async function changeOwnPassword(id: string, currentPassword: string, newPassword: string): Promise<{ ok: true }> {
  const row = await mustFind(id);
  // TASK-383: 400, not 401 — the request was well-formed and the SESSION is fine; the credential in the BODY was
  // wrong. A 401 collided with the FE's sign-out interceptor.
  if (!(await verifyPassword(currentPassword, row.passwordHash))) throw new ApiException(400, "WRONG_PASSWORD", "รหัสผ่านปัจจุบันไม่ถูกต้อง");
  assertPassword(newPassword);
  await db.update(users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(users.id, id));
  return { ok: true };
}

export async function createUser(
  input: { username: string; password: string; displayName: string; isSuperAdmin?: boolean },
  actor: string | null,
): Promise<UserDTO> {
  const username = normalizeUsername(input.username);
  if (!USERNAME_RE.test(username)) throw new ApiException(400, "VALIDATION", "ชื่อผู้ใช้ต้องเป็น a-z 0-9 . _ - ยาว 3–40 ตัว");
  assertPassword(input.password);
  const displayName = input.displayName.trim();
  if (!displayName) throw new ApiException(400, "VALIDATION", "กรุณาระบุชื่อที่แสดง");
  try {
    const [row] = await db
      .insert(users)
      .values({ username, passwordHash: await hashPassword(input.password), displayName, isSuperAdmin: !!input.isSuperAdmin, createdBy: actor })
      .returning();
    return toUserDTO(row!);
  } catch (e) {
    // 🔴 The UNIQUE's 23505 is caught HERE — `onError` renders every 23505 as `409 SLOT_TAKEN` ("the slot is taken").
    if (pgErrorCode(e) !== "23505") throw e;
    throw conflict("USERNAME_TAKEN", "ชื่อผู้ใช้นี้มีอยู่แล้ว");
  }
}

/**
 * The LAST-SUPER-ADMIN rule, pure: may this user lose super-admin standing (disable or demote)? Only if at
 * least one OTHER enabled super admin remains. Applies to the caller acting on themselves too.
 */
export const wouldRemoveLastSuperAdmin = (target: { isSuperAdmin: boolean; disabledAt: Date | string | null }, otherEnabledSuperAdmins: number): boolean =>
  target.isSuperAdmin && !target.disabledAt && otherEnabledSuperAdmins === 0;

async function otherEnabledSuperAdmins(id: string, exec: any = db): Promise<number> {
  const [row] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.isSuperAdmin, true), isNull(users.disabledAt), ne(users.id, id)));
  return Number(row?.n ?? 0);
}

async function mustFind(id: string) {
  const row = await findUserById(id);
  if (!row) throw notFound("ไม่พบผู้ใช้");
  return row;
}

const LAST_SUPER_ADMIN = () => conflict("LAST_SUPER_ADMIN", "ต้องมีผู้ดูแลระบบสูงสุดที่ใช้งานได้อย่างน้อย 1 คน");

export async function updateUser(id: string, input: { displayName?: string; isSuperAdmin?: boolean }): Promise<UserDTO> {
  const row = await mustFind(id);
  const patch: Record<string, unknown> = {};
  if (input.displayName !== undefined) {
    const d = input.displayName.trim();
    if (!d) throw new ApiException(400, "VALIDATION", "กรุณาระบุชื่อที่แสดง");
    patch.displayName = d;
  }
  if (input.isSuperAdmin !== undefined) {
    if (!input.isSuperAdmin && wouldRemoveLastSuperAdmin(row, await otherEnabledSuperAdmins(id))) throw LAST_SUPER_ADMIN();
    patch.isSuperAdmin = input.isSuperAdmin;
  }
  if (Object.keys(patch).length) await db.update(users).set(patch).where(eq(users.id, id));
  return userDTO(await mustFind(id));
}

export async function resetPassword(id: string, password: string): Promise<{ ok: true }> {
  await mustFind(id);
  assertPassword(password);
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, id));
  return { ok: true };
}

export async function setUserDisabled(id: string, disabled: boolean): Promise<UserDTO> {
  const row = await mustFind(id);
  if (disabled && wouldRemoveLastSuperAdmin(row, await otherEnabledSuperAdmins(id))) throw LAST_SUPER_ADMIN();
  await db.update(users).set({ disabledAt: disabled ? new Date() : null }).where(eq(users.id, id));
  return userDTO(await mustFind(id));
}

/**
 * 🔴 The BOOTSTRAP — at the FIRST LOGIN, not at server start (a start hook is a database call at import time:
 * every test that imports the root app, every restart, and on a box where pm2 restarts before `db:migrate`).
 * While `users` is EMPTY and the pair equals `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`, the
 * super admin is created (one log line) and the login proceeds against the row it just made. Once any user
 * exists the pair is ignored — the break-glass re-creates the first super admin only on an empty table
 * (SPEC-079 §3.1). The old `ADMIN_USERNAME` / `ADMIN_PASSWORD` login is RETIRED: nothing reads it.
 */
let bootstrapRefusalLogged = false;

/**
 * 🔴 TASK-380 — the env pair is checked against the SAME rules `createUser` applies (`USERNAME_RE`, `PASSWORD_MIN`)
 * BEFORE the call, and a breach is LOUD: one `console.error` per process and the specific 400 as the login's
 * answer. On `sid` the pair was `admin` / `admin` (5 chars): `createUser` threw `PASSWORD_TOO_SHORT` inside the
 * login, the FE showed its generic sentence, stdout said nothing, the table stayed empty, and the owner looped
 * for hours. 🚫 NEVER log a credential — the password's LENGTH class is the only fact about it that is printed.
 */
export function bootstrapEnvRefusal(envUser: string, envPass: string): ApiException | null {
  if (!USERNAME_RE.test(normalizeUsername(envUser))) {
    return new ApiException(400, "VALIDATION", "BOOTSTRAP_ADMIN_USERNAME ต้องเป็น a-z 0-9 . _ - ยาว 3–40 ตัว");
  }
  if (envPass.length < PASSWORD_MIN) {
    return new ApiException(400, "PASSWORD_TOO_SHORT", `BOOTSTRAP_ADMIN_PASSWORD ต้องยาวอย่างน้อย ${PASSWORD_MIN} ตัวอักษร — ตั้งค่าใหม่แล้วรีสตาร์ท`);
  }
  return null;
}

export async function bootstrapIfEmpty(username: string, password: string): Promise<boolean> {
  const envUser = process.env.BOOTSTRAP_ADMIN_USERNAME;
  const envPass = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!envUser || !envPass) return false;
  if (normalizeUsername(username) !== normalizeUsername(envUser) || password !== envPass) return false;
  if ((await countUsers()) !== 0) return false;
  const refusal = bootstrapEnvRefusal(envUser, envPass);
  if (refusal) {
    if (!bootstrapRefusalLogged) {
      bootstrapRefusalLogged = true;
      console.error(
        `[auth] bootstrap REFUSED: ${refusal.code === "PASSWORD_TOO_SHORT" ? `BOOTSTRAP_ADMIN_PASSWORD is shorter than ${PASSWORD_MIN}` : "BOOTSTRAP_ADMIN_USERNAME is invalid (a-z 0-9 . _ - , 3–40)"} — set it and restart. The users table is still empty.`,
      );
    }
    throw refusal;
  }
  await createUser({ username: envUser, password: envPass, displayName: envUser, isSuperAdmin: true }, "bootstrap");
  console.info(`[auth] bootstrap: first super admin "${normalizeUsername(envUser)}" created from env (users was empty)`);
  return true;
}

/** Login against the table. ONE sentence for unknown / wrong / disabled — no enumeration. `null` = refused. */
export async function authenticate(username: string, password: string) {
  await bootstrapIfEmpty(username, password);
  const row = await findUserByUsername(username);
  if (!row) return null;
  if (!(await verifyPassword(password, row.passwordHash))) return null;
  if (row.disabledAt) return null;
  return row;
}

/** One helper for every actor site: the request's user, by USERNAME — audit lines become real names. */
export const actorOf = (c: { get: (k: "user") => { username?: string } | undefined }): string | null => c.get("user")?.username ?? null;
