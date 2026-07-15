-- Badge system: admin-defined tags on bookings (replaces the multi-branch idea).
-- A badge TYPE groups many VALUES; a booking carries at most one value per type.
CREATE TABLE IF NOT EXISTS "badge_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "badge_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"badge_type_id" uuid NOT NULL,
	"label" text NOT NULL,
	"color" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "booking_badges" (
	"booking_id" uuid NOT NULL,
	"badge_value_id" uuid NOT NULL,
	"badge_type_id" uuid NOT NULL,
	CONSTRAINT "booking_badges_booking_id_badge_value_id_pk" PRIMARY KEY("booking_id","badge_value_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "badge_values" ADD CONSTRAINT "badge_values_badge_type_id_badge_types_id_fk" FOREIGN KEY ("badge_type_id") REFERENCES "badge_types"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_badges" ADD CONSTRAINT "booking_badges_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_badges" ADD CONSTRAINT "booking_badges_badge_value_id_badge_values_id_fk" FOREIGN KEY ("badge_value_id") REFERENCES "badge_values"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_badges" ADD CONSTRAINT "booking_badges_badge_type_id_badge_types_id_fk" FOREIGN KEY ("badge_type_id") REFERENCES "badge_types"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "badge_values_type_idx" ON "badge_values" USING btree ("badge_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "booking_badges_one_per_type_uq" ON "booking_badges" USING btree ("booking_id","badge_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_badges_value_idx" ON "booking_badges" USING btree ("badge_value_id");
