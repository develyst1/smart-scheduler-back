ALTER TYPE "public"."booking_status" ADD VALUE 'PENDING_RESCHEDULE' BEFORE 'CANCELLED';--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "incoming_booking_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "pending_slot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "reschedule_to" jsonb;