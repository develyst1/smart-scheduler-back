-- REQ-017 / TASK-044: per-teacher `.ics` subscription token. The token in the feed URL IS the credential, so it
-- must resolve to exactly one teacher → unique index. Additive + idempotent (hand-authored per drizzle/README.md;
-- do NOT run `db:generate` in this repo). Applied at deploy by the human via `bun run db:migrate`.
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "calendar_token" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teachers_calendar_token_uq" ON "teachers" ("calendar_token") WHERE "calendar_token" IS NOT NULL;
