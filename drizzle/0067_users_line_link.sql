-- TASK-725 (owner GO "ตามนั้น", shape 1) — the admin LINE link is tied to the WEB USER. `users.line_user_id` is the LINE account behind a web user; the one-time link code a
-- web admin asks for is stored HASHED (`line_link_code_hash`) with its expiry. Before this, an admin LINE was a bare id in `app_settings.line_admin_user_ids`, put there by
-- anyone who typed the shared admin code: no web user, no name, no role, and disabling a user stopped nothing. Those legacy ids are NOT touched or migrated here: the list
-- stays READ-ONLY and keeps notifying until each person re-links or the super admin removes them.
--
-- Forward-only, no backfill, no data rewritten: three nullable columns and two PARTIAL UNIQUE indexes (a LINE account belongs to at most one user; a live code hash is unique so
-- a typed code can name only one user). `ADD COLUMN` of a nullable column is a catalog change (no rewrite); the indexes are built on a table of a few rows.
-- Rerunnable: YES — every statement is IF NOT EXISTS. The LAST object is the code-hash index, so a half-applied file reads as "not applied" and re-runs (the witness rule).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "line_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "line_link_code_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "line_link_code_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_line_user_id_uq" ON "users" USING btree ("line_user_id") WHERE "line_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_line_link_code_hash_uq" ON "users" USING btree ("line_link_code_hash") WHERE "line_link_code_hash" is not null;
