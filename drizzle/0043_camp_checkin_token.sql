-- TASK-403 (REQ-095 Stage 3b, SPEC-082) — the camp DAY's check-in token + the undo's reason. Three NULLABLE columns on
-- `camp_days` and ONE partial unique index. Nothing else.
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 43 (0000–0042) and journal tags = 43 before this,
-- newest `0042`, so this is `0043` — the 44th file. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → `0039` → `0040` → `0041` → `0042` → THIS — one `db:migrate` run applies them in
-- journal order; `db:verify` expects 44. 🚫 No enum, no `'GROUP'`, no `bookings`.
--
-- ⚠️ Locks — catalog-only:
--   · Each `ALTER TABLE camp_days ADD COLUMN … NULL` (no default) is a catalog write: ACCESS EXCLUSIVE on `camp_days`
--     for a blink, no rewrite. `camp_days` was born in 0042 and is a small, staff-written table — not a hot table.
--   · The partial unique index builds on that young table in the same blink. No lock on any hot table (`bookings`
--     untouched).
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — the partial unique index `camp_days_checkin_token_uq`
-- — invented by this file, so a run that died after the columns is not called applied. Rerunnable: every object
-- IF NOT EXISTS.

-- The check-in token (the session QR's pattern — `bookings.checkin_token`, 0005 — on a camp DAY). Issued LAZILY on the
-- first QR view (`GET /camp/days/:id/checkin`), never at redeem: a day may be planned weeks ahead. NULL = never viewed.
ALTER TABLE "camp_days" ADD COLUMN IF NOT EXISTS "checkin_token" text NULL;
--> statement-breakpoint

-- 23:59:59+07:00 of the day's date — a camp day has no start time, so the token lives the whole date.
ALTER TABLE "camp_days" ADD COLUMN IF NOT EXISTS "checkin_token_expires_at" timestamptz NULL;
--> statement-breakpoint

-- The UNDO's reason (ATTENDED | ABSENT → PLANNED, units back, no money — §0 ruling 2). Required by validation on the
-- undo; cleared by the next mark. The row is the history (no audit table exists in this schema).
ALTER TABLE "camp_days" ADD COLUMN IF NOT EXISTS "undo_reason" text NULL;
--> statement-breakpoint

-- The token is the credential on the public route, so it is unique where it exists (the 0005 shape).
CREATE UNIQUE INDEX IF NOT EXISTS "camp_days_checkin_token_uq" ON "camp_days" ("checkin_token") WHERE "checkin_token" IS NOT NULL;
