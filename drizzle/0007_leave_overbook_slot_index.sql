-- UC-004: overbooking is only allowed onto a slot whose occupant is on leave
-- (SICK_LEAVE). A student on leave is not attending (and is auto-extended), so
-- their slot no longer "occupies" the teacher — exclude SICK_LEAVE from the unique
-- slot guard so a replacement booking can be created in that same slot.
DROP INDEX "bookings_teacher_slot_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_teacher_slot_uq" ON "bookings" USING btree ("teacher_id","date","start_time") WHERE "bookings"."status" not in ('CANCELLED', 'PENDING_RESCHEDULE', 'SICK_LEAVE');
