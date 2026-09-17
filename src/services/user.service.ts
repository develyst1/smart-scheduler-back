// TASK-377 (REQ-092 RBAC, SPEC-079 Stage 1) — real users. The ONE shared env login became a table: passwords
// are `Bun.password` (argon2id, built in), the guard reads the row on every request, and every audit `actor`
// is a real username. Super admins manage users; the LAST enabled super admin cannot be disabled or demoted.
//
// 🔴 `password_hash` never leaves this file: every reader goes through `toUserDTO`, which picks columns. A
// service that returned a row would leak the hash into the first `c.json(row)` somebody wrote.

import { and, asc, eq, inArray, isNull, like, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { userPermissions, users } from "../db/schema";
import { MENU_KEYS, isMenuKey, type MenuKey } from "../lib/permissions";
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
};

export const toUserDTO = (u: {
  id: string;
  username: string;
  displayName: string;
  isSuperAdmin: boolean;
  disabledAt: Date | string | null;
  createdAt: Date | string;
}, grants: Iterable<string> = []): UserDTO => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  isSuperAdmin: u.isSuperAdmin,
  disabledAt: u.disabledAt ? new Date(u.disabledAt).toISOString() : null,
  createdAt: new Date(u.createdAt).toISOString(),
  menus: u.isSuperAdmin ? [...MENU_KEYS] : MENU_KEYS.filter((m) => new Set(grants).has(m)),
});

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

/** TASK-381 — the guard's second read: this user's grant keys, one indexed query. */
export async function userGrantKeys(userId: string, exec: any = db): Promise<string[]> {
  const rows = await exec.select({ key: userPermissions.key }).from(userPermissions).where(eq(userPermissions.userId, userId));
  return rows.map((r: any) => r.key as string);
}

async function grantsByUser(userIds: string[], exec: any = db): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (userIds.length === 0) return out;
  const rows = await exec.select({ userId: userPermissions.userId, key: userPermissions.key }).from(userPermissions).where(inArray(userPermissions.userId, userIds));
  for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), r.key]);
  return out;
}

export async function listUsers() {
  const rows = await db.query.users.findMany({ orderBy: (u, { asc: a }) => [a(u.username)] });
  const grants = await grantsByUser(rows.map((r) => r.id)); // ONE grouped read, not one per user
  return rows.map((r) => toUserDTO(r, grants.get(r.id) ?? []));
}

/**
 * TASK-381 — REPLACE a user's `menu:*` grants with `keys` (unknown key ⇒ 400; duplicates collapse). A super-admin
 * target is accepted and stored — meaningless while super, and the set a later demotion lands on. One
 * transaction: delete the menu rows, insert the new ones.
 */
export async function setUserMenus(id: string, keys: string[], actor: string | null): Promise<UserDTO> {
  const row = await mustFind(id);
  const bad = keys.filter((k) => !isMenuKey(k));
  if (bad.length) throw new ApiException(400, "VALIDATION", `ไม่รู้จักเมนู: ${bad.join(", ")}`);
  const menus = [...new Set(keys)] as MenuKey[];
  await db.transaction(async (tx) => {
    await tx.delete(userPermissions).where(and(eq(userPermissions.userId, id), like(userPermissions.key, "menu:%")));
    if (menus.length) await tx.insert(userPermissions).values(menus.map((key) => ({ userId: id, key, grantedBy: actor })));
  });
  return toUserDTO(row, await userGrantKeys(id));
}

/** TASK-381 — any user changes their OWN password: the current one must verify (401), the new one min 8 (400). */
export async function changeOwnPassword(id: string, currentPassword: string, newPassword: string): Promise<{ ok: true }> {
  const row = await mustFind(id);
  if (!(await verifyPassword(currentPassword, row.passwordHash))) throw new ApiException(401, "UNAUTHORIZED", "รหัสผ่านปัจจุบันไม่ถูกต้อง");
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
  return toUserDTO(await mustFind(id), await userGrantKeys(id));
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
  return toUserDTO(await mustFind(id), await userGrantKeys(id));
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
