-- TASK-497 (owner ruling 09-26, Sober's (ii) 09-27) — an undone ATTENDANCE is recorded as what it was.
--
-- Undoing an attendance marked by mistake (TASK-258's door: a STAFF mark, a DAY-END mark, or a parent's check-in) now returns
-- the session to CONFIRMED (it used to write SICK_LEAVE — a leave the family never took). A CONFIRMED session on its own date is
-- re-attended by that night's day-end unless an undo record exempts it (TASK-492 ❓2) — so this door now writes the same
-- append-only `booking_undos` event the check-in Undo writes. 🔑 Its KIND must be TRUE: a staff or day-end mark was not a
-- check-in, so it is recorded as `attendance` — never as `checkin` (a false label inside the task that removes a false label).
-- A parent's check-in undone through this door is still `checkin`.
--
-- The only change: the CHECK on `booking_undos.kind` gains `attendance`. No backfill (no row of the new kind exists yet).
-- Numbering: counted at the moment of writing — `drizzle/*.sql` = 59 (0000-0058), journal tags = 59, newest `0058`
-- (when 1783000000054) ⇒ this is `0059`, when 1783000000055 — the 60th file (`db:generate`'s renumber; its unverifiable
-- snapshot removed, per drizzle/README.md).
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the constraint's DEFINITION contains 'attendance' — a name probe would pass on
-- 0058's old constraint. Rerunnable: DROP … IF EXISTS before the ADD (0057's shape); NOT VALID + VALIDATE.
ALTER TABLE "booking_undos" DROP CONSTRAINT IF EXISTS "booking_undos_kind_chk";
--> statement-breakpoint
ALTER TABLE "booking_undos" ADD CONSTRAINT "booking_undos_kind_chk" CHECK ("kind" IN ('leave', 'checkin', 'attendance')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "booking_undos" VALIDATE CONSTRAINT "booking_undos_kind_chk";
