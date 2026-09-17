// TASK-377 (REQ-092 RBAC, SPEC-079 Stage 1) — real users. The ONE shared env login became a table: passwords
// are `Bun.password` (argon2id, built in), the guard reads the row on every request, and every audit `actor`
// is a real username. Super admins manage users; the LAST enabled super admin cannot be disabled or demoted.
//
// 🔴 `password_hash` never leaves this file: every reader goes through `toUserDTO`, which picks columns. A
// service that returned a row would leak the hash into the first `c.json(row)` somebody wrote.

import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
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
};

export const toUserDTO = (u: {
  id: string;
  username: string;
  displayName: string;
  isSuperAdmin: boolean;
  disabledAt: Date | string | null;
  createdAt: Date | string;
}): UserDTO => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  isSuperAdmin: u.isSuperAdmin,
  disabledAt: u.disabledAt ? new Date(u.disabledAt).toISOString() : null,
  createdAt: new Date(u.createdAt).toISOString(),
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

export async function listUsers() {
  const rows = await db.query.users.findMany({ orderBy: (u, { asc: a }) => [a(u.username)] });
  return rows.map(toUserDTO);
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
  return toUserDTO(await mustFind(id));
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
  return toUserDTO(await mustFind(id));
}

/**
 * 🔴 The BOOTSTRAP — at the FIRST LOGIN, not at server start (a start hook is a database call at import time:
 * every test that imports the root app, every restart, and on a box where pm2 restarts before `db:migrate`).
 * While `users` is EMPTY and the pair equals `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`, the
 * super admin is created (one log line) and the login proceeds against the row it just made. Once any user
 * exists the pair is ignored — the break-glass re-creates the first super admin only on an empty table
 * (SPEC-079 §3.1). The old `ADMIN_USERNAME` / `ADMIN_PASSWORD` login is RETIRED: nothing reads it.
 */
export async function bootstrapIfEmpty(username: string, password: string): Promise<boolean> {
  const envUser = process.env.BOOTSTRAP_ADMIN_USERNAME;
  const envPass = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!envUser || !envPass) return false;
  if (normalizeUsername(username) !== normalizeUsername(envUser) || password !== envPass) return false;
  if ((await countUsers()) !== 0) return false;
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
