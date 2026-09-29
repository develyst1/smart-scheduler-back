-- TASK-573 §1 (REQ-110 item 6) — a course whose start date was MOVED after it was confirmed: its sessions went back to PENDING
-- and the family / coach still hold the OLD schedule until an admin re-confirms. The only PENDING attention check fires for
-- today / tomorrow, so such a course was INVISIBLE until the day before its first session. ⇒ the fact is written down at the
-- move (`changeCourseStart`), cleared when a course confirm leaves nothing pending (`confirmCourse`), and a 12th attention
-- check reads it from the moment of the move. NULL = nothing to re-confirm (every existing course — no backfill).
-- Numbering: counted at the moment of writing — `drizzle/*.sql` = 64 (0000-0063), journal tags = 64, newest `0063`
-- (when 1783000000059) ⇒ this is `0064`, when 1783000000060 — the 65th file. Hand-written (drizzle/README.md: no db:generate).
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the column, the ONLY object this file creates. Rerunnable: IF NOT EXISTS.
ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "reconfirm_needed_since" timestamptz;
