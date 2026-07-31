-- REQ-019 / TASK-048: staff people-management — demographics for the SOM dashboard + a reversible suspend.
-- All columns nullable so LINE self-registration and quick staff entry are never blocked. Store DOB (derive age
-- at read time); province lives on the PARENT (household), not duplicated per student.
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate`). Applied at deploy by the
-- human via `bun run db:migrate`.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "gender" text;
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "birth_date" date;
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "nationality" text;
--> statement-breakpoint
ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS "province" text;
--> statement-breakpoint
ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;
