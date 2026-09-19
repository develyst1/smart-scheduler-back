-- TASK-411 (REQ-098, SPEC-084) — archive a PARENT: three NULLABLE columns on `parents` and ONE partial index. Nothing
-- else. The phone STAYS (§3.1 — `parents_phone_uq` keeps holding it: an admin create with that number answers
-- `409 PARENT_ARCHIVED`, the LINE register answers `phone-archived`); the LINE accounts are CLEARED through the ONE
-- unlinker (`clearFamilyLine` — link rows + column) and kept here for the audit; the students CASCADE with
-- `archived_by = 'parent:<id>'` (REQ-093's columns, 0039).
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 46 (0000–0045) and journal tags = 46 before this,
-- newest `0045`, so this is `0046` — the 47th file. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → … → `0045` → THIS — one `db:migrate` run; `db:verify` expects 47.
--
-- ⚠️ Locks — catalog-only: each `ADD COLUMN … NULL` (no default) is a catalog blink under ACCESS EXCLUSIVE on
-- `parents` (a small table), no rewrite; the partial index builds in the same blink. No lock on any hot table
-- (`bookings` untouched).
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `parents_archived_idx` — invented by this file (the
-- restore view's read), so a run that died after the columns is not called applied. Rerunnable: every object
-- IF NOT EXISTS.

-- Set = archived: hidden from every WORKING read (the People list/search/count, the phone lookup, the notice
-- recipients, the attention nag, the SOM households, the LINE reply language); NULL = active. Cleared by restore.
ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz NULL;
--> statement-breakpoint

-- The archiving user's username (`actorOf`) — the students' `archived_by` convention (0039).
ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS "archived_by" text NULL;
--> statement-breakpoint

-- AUDIT ONLY: every LINE account the family held at the archive (primary first — `clearFamilyLine`'s order). Never
-- read by a lookup: `familyOfLineUser` resolves through `family_line_links` and `parents.line_user_id`, both cleared,
-- so the archived family cannot be reached from LINE by construction. A restore does NOT put them back — the
-- family re-links (§3.2).
ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS "archived_line_user_ids" text[] NULL;
--> statement-breakpoint

-- The restore view (`GET /parents?archived=1`) reads the archived rows only.
CREATE INDEX IF NOT EXISTS "parents_archived_idx" ON "parents" ("archived_at") WHERE "archived_at" IS NOT NULL;
