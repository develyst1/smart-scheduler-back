-- SPEC-070 / TASK-224 (REQ-078) — the `OTHER` booking type: อื่นๆ on the calendar.
--
-- A booking that is not a lesson — a meeting, a maintenance slot, a school visit. It may have no student and no
-- program, it carries its own typed title, and it may be run by SEVERAL teachers at once.
--
-- 🔴 Numbering: TASK-218 took `0028` (the outbox key). Counted at the moment of writing — `drizzle/*.sql` = 29,
-- journal tags = 29 — so this is `0029` (board rule: *"no migration" is a CLAIM, not a state*).
-- Hand-authored + journal-registered per drizzle/README.md; do NOT run `db:generate` (snapshots stop at 0003).
--
-- ⚠️ TRAP 1 — `ALTER TYPE … ADD VALUE` and the value's first USE must not share a transaction. `drizzle-kit
-- migrate` runs the whole pending set inside ONE transaction, so nothing in this file may reference `'OTHER'`:
-- no backfill, no CHECK naming it, no seed. Nothing here does. **Keep it that way.**
--
-- ⚠️ TRAP 2 — `DROP NOT NULL` is NOT witnessable by existence: *"does `student_id` exist?"* is true before AND
-- after, so an un-migrated box would look identical to a migrated one. That blindness is how `0022` hid and
-- took the calendar down. The witness is `booking_other_price_chk` — an object that exists only after this ran.
ALTER TYPE "booking_type" ADD VALUE IF NOT EXISTS 'OTHER';
--> statement-breakpoint

-- An อื่นๆ booking may have no student and no program.
-- 🚫 NOT a placeholder `อื่นๆ` row in `subjects`: REQ-065 exists because `1st Trial` sitting in that table leaked
-- into the program picker and had to be filtered back out at `toTeacherDTO`. A booking with no program has none.
ALTER TABLE "bookings" ALTER COLUMN "student_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "subject_id" DROP NOT NULL;
--> statement-breakpoint

-- The typed name of an อื่นๆ booking. It is what `displayName` renders, so AC-10 ("never blank, never the word
-- อื่นๆ") is a property of one computed field rather than a promise repeated across the FE.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "other_title" text;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "other_price_minor" integer;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "other_price_item_id" uuid;
--> statement-breakpoint

-- 🆕 AC-18/19/20 (owner, 2026-08-31): *"ทุกการจองต้องมีครู แค่การจองนั้น อาจจะครูหลายคนได้"*.
--
-- `bookings.teacher_id` STAYS NOT NULL and is the FIRST teacher; this table holds the ADDITIONAL ones only.
-- Additive by design ⇒ every existing reader, index, freelance hold and report is untouched, and AC-20 (the
-- other four types take exactly one teacher) is true by construction rather than by a rule someone must enforce.
--
-- `ON DELETE CASCADE` is what makes AC-18's "cancelling removes it from all three columns" free: there is still
-- exactly ONE booking row, so a cancel stays one status change. `RESTRICT` on the teacher matches
-- `bookings.teacher_id` — a teacher with history is never silently deleted out from under a booking.
CREATE TABLE IF NOT EXISTS "booking_teachers" (
  "booking_id" uuid NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE,
  "teacher_id" uuid NOT NULL REFERENCES "teachers"("id") ON DELETE RESTRICT,
  PRIMARY KEY ("booking_id", "teacher_id")
);
--> statement-breakpoint

-- AC-12: a charge is EITHER a typed amount OR a catalogue item — never both. Refuse, never clamp, never pick
-- one for the user (REQ-063's line). The app refuses it first; this is the backstop that makes the rule true of
-- the DATA and not only of the path that happens to write it — the TASK-217 lesson, in the other direction.
--
-- 🔑 THE WITNESS for 0029: this constraint exists only after this migration ran. Named last, and created after
-- the columns it constrains, so a half-applied run reads as "not applied" rather than as finished.
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "booking_other_price_chk";
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "booking_other_price_chk"
  CHECK ("other_price_minor" IS NULL OR "other_price_item_id" IS NULL);
