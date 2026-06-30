CREATE TABLE IF NOT EXISTS "parents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"line_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "parents_phone_uq" ON "parents" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "parents_line_user_id_uq" ON "parents" USING btree ("line_user_id") WHERE "line_user_id" is not null;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "parent_id" uuid;--> statement-breakpoint
-- Backfill: one parent per distinct student phone, carrying the first known LINE userId.
INSERT INTO "parents" ("phone", "line_user_id")
SELECT s.phone, (array_agg(s.parent_line_user_id) FILTER (WHERE s.parent_line_user_id IS NOT NULL))[1]
FROM "students" s
WHERE s.phone IS NOT NULL AND btrim(s.phone) <> ''
GROUP BY s.phone
ON CONFLICT ("phone") DO NOTHING;--> statement-breakpoint
-- Link students to their new parent rows by phone.
UPDATE "students" s SET "parent_id" = p.id
FROM "parents" p
WHERE s.parent_id IS NULL AND s.phone IS NOT NULL AND btrim(s.phone) <> '' AND p.phone = s.phone;--> statement-breakpoint
-- Edge case: a student with a parent LINE userId but no phone — give it a standalone parent.
INSERT INTO "parents" ("phone", "line_user_id")
SELECT 'unknown-' || s.id::text, s.parent_line_user_id
FROM "students" s
WHERE s.parent_id IS NULL
  AND s.parent_line_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "parents" p2 WHERE p2.line_user_id = s.parent_line_user_id);--> statement-breakpoint
UPDATE "students" s SET "parent_id" = p.id
FROM "parents" p
WHERE s.parent_id IS NULL AND s.parent_line_user_id IS NOT NULL AND p.line_user_id = s.parent_line_user_id;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "students" ADD CONSTRAINT "students_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "parents"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "students_parent_idx" ON "students" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN IF EXISTS "phone";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN IF EXISTS "parent_line_user_id";
