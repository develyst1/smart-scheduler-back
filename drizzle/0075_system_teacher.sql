-- TASK-861 (REQ-120 F5) — ONE system teacher, "No Teacher", so a park-fee block (an OTHER booking rented to an outside party, no lesson) can sit on the calendar without a real coach owning it. `bookings.teacher_id` stays NOT NULL; the system
-- teacher is excluded by the code from everything that measures, pays or messages a coach. ADDITIVE ONLY: one column with a default, one partial unique index (exactly one row may carry it), one idempotent row.
-- Hand-authored + journal-registered per drizzle/README.md (the snapshots stop at 0003 — do NOT run db:generate). Numbered 0075 = the 76th file; re-check against MIGRATION-QUEUE.md at apply time.
-- Rerunnable: the column IF NOT EXISTS; the insert is `WHERE NOT EXISTS (… is_system)` so a re-run inserts nothing; the index IF NOT EXISTS. LOCKS: `teachers` is a tiny table — the column default is a constant, so no rewrite.
-- The row: name = nickname = 'No Teacher', type FREELANCE, active, not archived, line_user_id NULL (so it can never be messaged), work_days = the table's default (all 7).
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `teachers_one_system_uq` — is invented by this file, so a run that died after the column or the row is not called applied (and its re-run is safe: the row is guarded).

ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "is_system" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

INSERT INTO "teachers" ("name", "nickname", "type", "active", "archived", "is_system")
SELECT 'No Teacher', 'No Teacher', 'FREELANCE', true, false, true
WHERE NOT EXISTS (SELECT 1 FROM "teachers" WHERE "is_system");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "teachers_one_system_uq" ON "teachers" ("is_system") WHERE "is_system";
