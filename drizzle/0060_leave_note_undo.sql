-- TASK-540 (Tanya TEST-075 F1; Sober's ruling 09-28) — an undone leave restores the note the leave replaced.
--
-- Both leave writers did `note = reason ?? note`: a leave WITH a reason overwrote the booking's note in place and nothing kept the
-- old one, so an undone leave left the absence's reason on a CONFIRMED session. It cannot be repaired from existing data (at Undo, a
-- leave's reason and an admin's own note are indistinguishable), so the leave now RECORDS what it did:
--   `leave_note_replaced` — true only when a leave wrote a reason over the note;
--   `note_before_leave`   — the note it replaced (NULL = there was none).
-- The Undo restores only when `leave_note_replaced`; a staff edit of the note resets it. No backfill: a leave written before this
-- migration keeps the default `false`, and its Undo leaves the note as is (what it overwrote is unknowable).
-- Numbering: counted at the moment of writing — `drizzle/*.sql` = 60 (0000-0059), journal tags = 60, newest `0059`
-- (when 1783000000055) ⇒ this is `0060`, when 1783000000056 — the 61st file. Hand-written (drizzle/README.md: no db:generate).
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): `note_before_leave`, the LAST object this file creates. Rerunnable: IF NOT EXISTS.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "leave_note_replaced" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "note_before_leave" text;
