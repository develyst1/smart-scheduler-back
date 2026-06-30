ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "crm_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "crm_level" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "checkin_token" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "checkin_token_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_checkin_token_uq" ON "bookings" USING btree ("checkin_token") WHERE "checkin_token" is not null;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "line_link_sessions" (
	"line_user_id" text PRIMARY KEY NOT NULL,
	"step" text NOT NULL,
	"pending_role" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
