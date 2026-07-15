// Badge system — admin-defined tags on bookings. A badge TYPE groups many VALUES;
// a booking carries at most one value per type. Replaces the multi-branch idea.

import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "../db";
import {
  badgeTypes,
  badgeValues,
  bookingBadges,
  bookings,
  teachers,
} from "../db/schema";
import { toBadgeTypeDTO, toBadgeValueDTO } from "../db/mappers";
import { findTypeConflict } from "../lib/badge-rules";
import { badRequest, notFound } from "../lib/http";

// ───────────────────────────── Reads ─────────────────────────────

/** All badge types with their values. `includeInactive` = admin management view. */
export async function listBadges(includeInactive = false) {
  const types = await db.query.badgeTypes.findMany({
    with: { values: true },
    orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.createdAt)],
  });
  return types
    .filter((t) => includeInactive || t.active)
    .map((t) => ({
      ...toBadgeTypeDTO(t),
      values: (t.values ?? [])
        .filter((v: any) => includeInactive || v.active)
        .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
        .map(toBadgeValueDTO),
    }));
}

// ───────────────────────── Types CRUD ─────────────────────────

export async function createBadgeType(input: { name: string; sortOrder?: number }) {
  const [row] = await db
    .insert(badgeTypes)
    .values({ name: input.name, sortOrder: input.sortOrder ?? 0 })
    .returning();
  return toBadgeTypeDTO({ ...row, values: [] });
}

export async function updateBadgeType(
  id: string,
  patch: { name?: string; active?: boolean; sortOrder?: number },
) {
  const [row] = await db
    .update(badgeTypes)
    .set(patch)
    .where(eq(badgeTypes.id, id))
    .returning();
  if (!row) throw notFound("ไม่พบ badge type");
  const values = await db.query.badgeValues.findMany({
    where: (v, { eq }) => eq(v.badgeTypeId, id),
  });
  return toBadgeTypeDTO({ ...row, values });
}

// ───────────────────────── Values CRUD ─────────────────────────

export async function createBadgeValue(input: {
  badgeTypeId: string;
  label: string;
  color: string;
  sortOrder?: number;
}) {
  const type = await db.query.badgeTypes.findFirst({
    where: (t, { eq }) => eq(t.id, input.badgeTypeId),
  });
  if (!type) throw badRequest("ไม่พบ badge type");
  const [row] = await db
    .insert(badgeValues)
    .values({
      badgeTypeId: input.badgeTypeId,
      label: input.label,
      color: input.color,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();
  return toBadgeValueDTO(row);
}

export async function updateBadgeValue(
  id: string,
  patch: { label?: string; color?: string; active?: boolean; sortOrder?: number },
) {
  const [row] = await db
    .update(badgeValues)
    .set(patch)
    .where(eq(badgeValues.id, id))
    .returning();
  if (!row) throw notFound("ไม่พบ badge value");
  return toBadgeValueDTO(row);
}

// ───────────────────── Attach to a booking ─────────────────────

/**
 * Replace all badges on a booking with `valueIds` (≤ 1 per type). Runs inside the
 * caller's transaction. Rejects unknown/inactive values and same-type conflicts.
 */
export async function attachBookingBadges(exec: any, bookingId: string, valueIds: string[]) {
  await exec.delete(bookingBadges).where(eq(bookingBadges.bookingId, bookingId));
  if (!valueIds.length) return;

  const unique = [...new Set(valueIds)];
  const values = await exec.query.badgeValues.findMany({
    where: (v: any, { inArray }: any) => inArray(v.id, unique),
  });
  if (values.length !== unique.length) throw badRequest("badge value บางรายการไม่พบ");
  const inactive = values.find((v: any) => !v.active);
  if (inactive) throw badRequest(`badge "${inactive.label}" ถูกปิดใช้งานแล้ว`);

  const conflict = findTypeConflict(
    values.map((v: any) => ({ id: v.id, typeId: v.badgeTypeId })),
  );
  if (conflict) throw badRequest("เลือก badge ได้ไม่เกิน 1 ค่าต่อ 1 ประเภท");

  await exec.insert(bookingBadges).values(
    values.map((v: any) => ({
      bookingId,
      badgeValueId: v.id,
      badgeTypeId: v.badgeTypeId,
    })),
  );
}

/** Public entry: set a booking's badges in its own transaction, return the booking's badges. */
export async function setBookingBadges(bookingId: string, valueIds: string[]) {
  return await db.transaction(async (tx) => {
    const booking = await tx.query.bookings.findFirst({
      where: (b, { eq }) => eq(b.id, bookingId),
    });
    if (!booking) throw notFound("ไม่พบคาบเรียน");
    await attachBookingBadges(tx, bookingId, valueIds);
    const rows = await tx.query.bookingBadges.findMany({
      where: (bb, { eq }) => eq(bb.bookingId, bookingId),
      with: { value: true, type: true },
    });
    return {
      bookingId,
      badges: rows.map((bb: any) => ({
        typeId: bb.badgeTypeId,
        typeName: bb.type?.name ?? null,
        valueId: bb.badgeValueId,
        label: bb.value?.label ?? null,
        color: bb.value?.color ?? null,
      })),
    };
  });
}

// ───────────────────────── Dashboard report ─────────────────────────

/** Booking counts per badge value, and per teacher × badge value, over a date range. */
export async function getBadgeReport(from: string, to: string) {
  const inRange = and(
    gte(bookings.date, from),
    lte(bookings.date, to),
    ne(bookings.status, "CANCELLED"),
  );

  const byValue = await db
    .select({
      valueId: badgeValues.id,
      label: badgeValues.label,
      color: badgeValues.color,
      typeId: badgeTypes.id,
      typeName: badgeTypes.name,
      count: sql<number>`count(*)::int`,
    })
    .from(bookingBadges)
    .innerJoin(bookings, eq(bookingBadges.bookingId, bookings.id))
    .innerJoin(badgeValues, eq(bookingBadges.badgeValueId, badgeValues.id))
    .innerJoin(badgeTypes, eq(bookingBadges.badgeTypeId, badgeTypes.id))
    .where(inRange)
    .groupBy(badgeValues.id, badgeValues.label, badgeValues.color, badgeTypes.id, badgeTypes.name)
    .orderBy(asc(badgeTypes.name), asc(badgeValues.label));

  const byTeacher = await db
    .select({
      teacherId: teachers.id,
      teacherNickname: teachers.nickname,
      valueId: badgeValues.id,
      label: badgeValues.label,
      color: badgeValues.color,
      count: sql<number>`count(*)::int`,
    })
    .from(bookingBadges)
    .innerJoin(bookings, eq(bookingBadges.bookingId, bookings.id))
    .innerJoin(teachers, eq(bookings.teacherId, teachers.id))
    .innerJoin(badgeValues, eq(bookingBadges.badgeValueId, badgeValues.id))
    .where(inRange)
    .groupBy(teachers.id, teachers.nickname, badgeValues.id, badgeValues.label, badgeValues.color)
    .orderBy(asc(teachers.nickname), asc(badgeValues.label));

  return { from, to, byValue, byTeacher };
}
