-- SPEC-059 / TASK-162 (REQ-063) — a discount captured on a booking, posted at day-end.
--
-- Why the discount lives on the BOOKING rather than being applied at posting time: 1st Trial and single-session
-- revenue posts from the end-of-day job, when nobody is present to authorise anything. The admin *is* present
-- when the session is booked — so the decision (and who made it) is captured there, and only the POSTING is
-- deferred. Without these columns the day-end job would have to invent an author for a discount it never saw.
--
-- All four nullable and additive: every existing booking is untouched, and a booking with no discount behaves
-- exactly as it does today.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate` — the snapshot chain stops
-- at 0003). Idempotent.

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "discount_kind" text;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "discount_value" integer;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "discount_reason" text;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "discount_actor" text;
--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_discount_kind_chk";
--> statement-breakpoint
-- The kind is a closed set; a typo'd value would be a discount nobody can price at day-end.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_discount_kind_chk"
  CHECK ("discount_kind" IS NULL OR "discount_kind" IN ('PERCENT', 'BAHT'));
