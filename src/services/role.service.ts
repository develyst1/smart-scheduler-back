// TASK-387 (REQ-092 RBAC, SPEC-079 Stage 4) — roles: a NAMED SET of permission keys a user references. Live: the
// guard reads the role's rows per request (`effectiveGrantKeys`), so an edit here reaches every holder at their
// next request with no propagation. Keys are validated against the code registry (`MENU_KEYS ∪ ACTION_KEYS`).

import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { rolePermissions, roles, users } from "../db/schema";
import { ACTION_KEYS, MENU_KEYS, isActionKey, isMenuKey } from "../lib/permissions";
import { ApiException, conflict, notFound, pgErrorCode } from "../lib/http";

export const ROLE_NAME_MAX = 60;

export type RoleDTO = {
  id: string;
  name: string;
  description: string | null;
  /** Registry order: menus, then actions. */
  keys: string[];
  /** Users whose `role_id` is this role — what `DELETE` refuses on. */
  userCount: number;
  createdAt: string;
  updatedAt: string;
};

/** Every key the registry knows, in the order the checklists show them — the order a role's keys are handed back in. */
export const ALL_KEYS: readonly string[] = [...MENU_KEYS, ...ACTION_KEYS];
export const isPermissionKey = (k: string): boolean => isMenuKey(k) || isActionKey(k);

/** Unknown keys ⇒ 400 BEFORE any write; duplicates collapse; the result is in registry order. */
export function normalizeKeys(keys: string[]): string[] {
  const bad = keys.filter((k) => !isPermissionKey(k));
  if (bad.length) throw new ApiException(400, "VALIDATION", `ไม่รู้จักสิทธิ์: ${bad.join(", ")}`);
  const set = new Set(keys);
  return ALL_KEYS.filter((k) => set.has(k));
}

export function normalizeRoleName(name: string): string {
  const n = name.trim();
  if (!n) throw new ApiException(400, "VALIDATION", "กรุณาระบุชื่อบทบาท");
  if (n.length > ROLE_NAME_MAX) throw new ApiException(400, "VALIDATION", `ชื่อบทบาทยาวได้ไม่เกิน ${ROLE_NAME_MAX} ตัวอักษร`);
  return n;
}

const ROLE_NAME_TAKEN = () => conflict("ROLE_NAME_TAKEN", "มีบทบาทชื่อนี้แล้ว");
export const ROLE_IN_USE = (n: number) => conflict("ROLE_IN_USE", `มีผู้ใช้ ${n} คนถืออยู่ — ย้ายก่อนลบ`);
const ROLE_NOT_FOUND = () => notFound("ไม่พบบทบาท");

const toRoleDTO = (r: { id: string; name: string; description: string | null; createdAt: Date | string; updatedAt: Date | string }, keys: string[], userCount: number): RoleDTO => ({
  id: r.id,
  name: r.name,
  description: r.description,
  keys: ALL_KEYS.filter((k) => keys.includes(k)),
  userCount,
  createdAt: new Date(r.createdAt).toISOString(),
  updatedAt: new Date(r.updatedAt).toISOString(),
});

/** The keys of several roles in ONE read — the list, the users list, and the DTO after a write all use it. */
export async function roleKeysByIds(roleIds: string[], exec: any = db): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (roleIds.length === 0) return out;
  const rows = await exec.select({ roleId: rolePermissions.roleId, key: rolePermissions.key }).from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
  for (const r of rows) out.set(r.roleId, [...(out.get(r.roleId) ?? []), r.key]);
  return out;
}

/** Holder counts per role in ONE grouped read. */
async function userCountsByRole(roleIds: string[], exec: any = db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (roleIds.length === 0) return out;
  const rows = await exec.select({ roleId: users.roleId, n: count() }).from(users).where(inArray(users.roleId, roleIds)).groupBy(users.roleId);
  for (const r of rows) if (r.roleId) out.set(r.roleId, Number(r.n));
  return out;
}

export async function findRole(id: string, exec: any = db) {
  return (await exec.query.roles.findFirst({ where: (r: any, { eq: e }: any) => e(r.id, id) })) ?? null;
}

/** The role's name for `/me` — no query at all when the user holds none. */
export async function roleNameOf(roleId: string | null | undefined): Promise<string | null> {
  if (!roleId) return null;
  const r = await db.select({ name: roles.name }).from(roles).where(eq(roles.id, roleId));
  return r[0]?.name ?? null;
}

async function dtoOf(id: string): Promise<RoleDTO> {
  const row = await findRole(id);
  if (!row) throw ROLE_NOT_FOUND();
  const [keys, counts] = await Promise.all([roleKeysByIds([id]), userCountsByRole([id])]);
  return toRoleDTO(row, keys.get(id) ?? [], counts.get(id) ?? 0);
}

/** THREE reads for the whole list (roles · keys grouped · holder counts grouped), never per role. */
export async function listRoles(): Promise<RoleDTO[]> {
  const rows = await db.select().from(roles).orderBy(asc(sql`lower(${roles.name})`));
  const ids = rows.map((r) => r.id);
  const [keys, counts] = await Promise.all([roleKeysByIds(ids), userCountsByRole(ids)]);
  return rows.map((r) => toRoleDTO(r, keys.get(r.id) ?? [], counts.get(r.id) ?? 0));
}

export async function createRole(input: { name: string; description?: string | null; keys: string[] }, actor: string | null): Promise<RoleDTO> {
  const name = normalizeRoleName(input.name);
  const keys = normalizeKeys(input.keys); // refuse BEFORE the transaction
  const description = input.description?.trim() || null;
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [r] = await tx.insert(roles).values({ name, description, createdBy: actor }).returning({ id: roles.id });
      if (keys.length) await tx.insert(rolePermissions).values(keys.map((key) => ({ roleId: r!.id, key, grantedBy: actor })));
      return r!.id;
    });
  } catch (e) {
    // The UNIQUE on lower(name) — caught HERE (onError would render every 23505 as SLOT_TAKEN).
    if (pgErrorCode(e) === "23505") throw ROLE_NAME_TAKEN();
    throw e;
  }
  return dtoOf(id);
}

/** `keys` REPLACES the role's rows (delete + insert the deduplicated set, one tx) — the `replaceGrants` shape. */
export async function updateRole(id: string, input: { name?: string; description?: string | null; keys?: string[] }, actor: string | null): Promise<RoleDTO> {
  const row = await findRole(id);
  if (!row) throw ROLE_NOT_FOUND();
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = normalizeRoleName(input.name);
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  const keys = input.keys === undefined ? undefined : normalizeKeys(input.keys); // refuse BEFORE the transaction
  try {
    await db.transaction(async (tx) => {
      if (Object.keys(patch).length) await tx.update(roles).set(patch).where(eq(roles.id, id));
      if (keys !== undefined) {
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
        if (keys.length) await tx.insert(rolePermissions).values(keys.map((key) => ({ roleId: id, key, grantedBy: actor })));
      }
    });
  } catch (e) {
    if (pgErrorCode(e) === "23505") throw ROLE_NAME_TAKEN();
    throw e;
  }
  return dtoOf(id);
}

/**
 * Refuse a role in use WITH the count, before touching anything; the FK `RESTRICT` is the backstop (a 23503 there
 * — a holder assigned between the count and the delete — maps to the same 409 with a fresh count).
 */
export async function deleteRole(id: string): Promise<{ deleted: true }> {
  const row = await findRole(id);
  if (!row) throw ROLE_NOT_FOUND();
  const holders = await holderCount(id);
  if (holders > 0) throw ROLE_IN_USE(holders);
  try {
    await db.delete(roles).where(eq(roles.id, id)); // role_permissions go with it (CASCADE)
  } catch (e) {
    if (pgErrorCode(e) === "23503") throw ROLE_IN_USE(await holderCount(id));
    throw e;
  }
  return { deleted: true };
}

async function holderCount(roleId: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(users).where(and(eq(users.roleId, roleId)));
  return Number(r?.n ?? 0);
}
