// TASK-406 (REQ-097, SPEC-083 §1.2) — OWN SCOPE: a user linked to a teacher (`users.teacher_id`, 0044) sees and
// touches only the bookings they teach. ONE predicate, used by every scoped read and asserted by every scoped write —
// no read builds its own filter (pinned by source).
//
// 🔑 Scope is the LINK, not a grant: a grant that must be ABSENT to narrow a read fails OPEN (an account created
// without it sees everything); the link fails CLOSED — the moment `teacher_id` is set the account is narrowed, whatever
// its role grants. An admin who also teaches keeps a separate, unlinked account (§3.2).
//
// "Mine" = the row's `teacher_id` is me OR I am one of its extra teachers (`booking_teachers`) — an EXISTS subquery,
// never a join: the relational readers (`withBookingRelations`) and `getBookings`' select have no join to hang a
// filter on, and a join would multiply rows. The condition is plain drizzle SQL on the root table, so it drops into a
// relational `where` callback and a `conds[]` array unchanged.
import { and, eq, exists, or, sql } from "drizzle-orm";
import { db } from "../db";
import { bookingTeachers, bookings, teachers } from "../db/schema";
import { ApiException, notFound } from "./http";

export interface ScopedUser { teacherId: string | null }

/** A linked account. */
export const isScoped = (u: ScopedUser): boolean => !!u.teacherId;
/** The teacher id the reads narrow to, or `null` for an unscoped admin (every read untouched). */
export const scopeOf = (u: ScopedUser): string | null => u.teacherId ?? null;

/** THE predicate: `bookings.teacher_id = me OR EXISTS booking_teachers(me)`. */
export const ownScopeWhere = (me: string | typeof teachers.id) => // TASK-508 — or the teachers' own id column: the inverse question
  or(
    eq(bookings.teacherId, me),
    exists(db.select({ one: sql`1` }).from(bookingTeachers).where(and(eq(bookingTeachers.bookingId, bookings.id), eq(bookingTeachers.teacherId, me)))),
  );

/**
 * 🔴 TASK-508 — the coaches OF a booking: every teacher for whom THE predicate holds on this row (the primary AND each
 * additional teacher). The inverse of "my classes", asked through the SAME predicate with the teacher's id column in place
 * of a fixed id — so it can never know fewer people than a coach's own calendar does (TASK-487's lesson).
 */
export async function teachersOfBooking(exec: any, bookingId: string): Promise<Array<{ id: string; lineUserId: string | null }>> {
  return exec
    .select({ id: teachers.id, lineUserId: teachers.lineUserId })
    .from(teachers)
    .innerJoin(bookings, and(eq(bookings.id, bookingId), ownScopeWhere(teachers.id)));
}

/** Is this booking mine? The same predicate + the id — the by-id reads and the scoped write share it. */
export async function isOwnBooking(exec: any, bookingId: string, me: string): Promise<boolean> {
  const [row] = await exec.select({ id: bookings.id }).from(bookings).where(and(eq(bookings.id, bookingId), ownScopeWhere(me))).limit(1);
  return !!row;
}

/**
 * A by-id read/write for a scoped user: outside my scope ⇒ **404**, not 403 — the row's existence is not theirs to
 * know about (§1.3). An unscoped user (`me = null`) passes untouched.
 */
export async function assertOwnBooking(bookingId: string, me: string | null, exec: any = db): Promise<void> {
  if (!me) return;
  if (!(await isOwnBooking(exec, bookingId, me))) throw notFound("ไม่พบคาบเรียน");
}

/** The ONE refusal a linked account gets for anything beyond its own calendar, check-in and leave. */
export const SCOPE_TEACHER = () => new ApiException(403, "SCOPE_TEACHER", "บัญชีครูทำได้เฉพาะดูตารางตัวเอง เช็คอิน และแจ้งลา");

/**
 * `PATCH /bookings/:id/status` for a linked account: `attend` ONLY (§1.4 — confirm / sick-leave / cancel are the
 * admin's). At the route, beside `assertMayOverrideLeave`: the access guard cannot read a body.
 */
export function assertScopedStatusAction(u: ScopedUser, action: string): void {
  if (isScoped(u) && action !== "attend") throw SCOPE_TEACHER();
}

/** `POST /teachers/me/leave` is for a LINKED account only — the act alone is not an identity. */
export function assertLinked(u: ScopedUser): string {
  if (!u.teacherId) throw SCOPE_TEACHER();
  return u.teacherId;
}
