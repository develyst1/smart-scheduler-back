-- TASK-392 (REQ-093, shape (a)) — ARCHIVE a student: `students.archived_at` + `archived_by`.
--
-- 🔴 Numbering: counted at the moment of writing, per the board rule ("no migration" is a CLAIM, not a state) —
-- `drizzle/*.sql` = 39 (0000–0038) and journal tags = 39 before this, newest `0038`, so this is `0039` — the
-- 40th file. Hand-authored + journal-registered per drizzle/README.md; do NOT run `db:generate` (snapshots stop
-- at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038_course_rental_marker` (TASK-390) then THIS — two files, ONE `db:migrate` run applies
-- both in journal order; `db:verify` expects 40. Neither depends on the other's objects.
--
-- 📌 WHY A COLUMN. The owner chose ARCHIVE over merge/hard-delete: a wrongly created child (a LINE link that
-- made a duplicate, a typo) is HIDDEN from every working read — the pickers, the parent's children, the LIFF
-- lists, the attention row — while everything that happened to them (bookings, courses, vouchers, the ledger,
-- the messages) stays readable. Nothing is deleted; one tap restores. A child with LIVE FUTURE sessions cannot
-- be archived (the service refuses with the count) — archiving is for mistakes, and a scheduled class is not one.
--
-- 🔒 THE LOCK — read this before running it (the human runs it; it is why this comment exists):
--   · Each `ALTER TABLE students ADD COLUMN` takes **ACCESS EXCLUSIVE on `students`** for the duration of its
--     statement: reads AND writes wait. A NULLable column with no default is a catalog write — **no table
--     rewrite, no backfill**. `students` is hundreds of rows. Two statements ⇒ two blinks of milliseconds, in
--     ONE transaction.
--   · ⚠️ The queueing hazard: the booking pickers, the People page and the calendar's student joins read
--     `students`; if a transaction holds it when this starts, the ALTER queues behind it and every such read
--     queues behind the ALTER. ⇒ a read-blocking blink — run it at a quiet moment, not during an import.
--   · ONE run, ONE transaction, two statements; both `IF NOT EXISTS` ⇒ rerunnable. No other table is touched.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — the column `archived_by` — invented by this
-- migration (0034's rules). Witnessing `archived_at` would call a run that died between the two statements
-- "applied", and the actor would have no home.

-- Set = archived: hidden from every WORKING read (pickers, parent detail's `students`, LIFF, attention); history
-- untouched. NULL = active. Cleared by un-archive.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz NULL;
--> statement-breakpoint

-- The archiving user's username (`actorOf`). Same convention as `dropped_by` / `created_by`.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "archived_by" text NULL;
