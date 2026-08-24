-- SPEC-064 / TASK-181 (REQ-036) — a course ENDED early: the family stops, the remaining sessions are forfeited,
-- and the plan must never quietly owe them again.
--
-- 🔴 Why a flag and not a smaller `size`: `size` is what the family BOUGHT. Reducing it to "close" the course
-- would make the card, the leave quota and the expiry ceiling all describe a purchase that never happened —
-- the same corruption REQ-064 spent a migration undoing. `ended_at` leaves the purchase honest and lets the
-- three plan-responsibility sites answer "this course owes nothing" **by construction, permanently**, rather
-- than because one reconcile happened to be skipped.
--
-- `end_reason` is a closed set so an ADMIN_ERROR course is findable later with one query — that is the whole
-- reason the enum exists; the money follow-up is a separate, human decision.
--
-- All four nullable and additive: every existing course is untouched and behaves exactly as it does today.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate` — the snapshot chain stops
-- at 0003). Idempotent.

ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "ended_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "end_reason" text;
--> statement-breakpoint
ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "end_note" text;
--> statement-breakpoint
ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "ended_by" text;
--> statement-breakpoint
ALTER TABLE "course_packages" DROP CONSTRAINT IF EXISTS "course_packages_end_reason_chk";
--> statement-breakpoint
-- A typo'd reason is an ended course nobody can find again — which defeats the one job the enum has.
ALTER TABLE "course_packages" ADD CONSTRAINT "course_packages_end_reason_chk"
  CHECK ("end_reason" IS NULL OR "end_reason" IN ('PROGRAM_CHANGED', 'CUSTOMER_CANCELLED', 'ADMIN_ERROR'));
