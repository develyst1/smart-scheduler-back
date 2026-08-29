-- SPEC-067 / TASK-211 (REQ-074) — WHY a booking was cancelled, as a closed set.
--
-- 🔴 Why a column and not the existing free-text `note`: the whole reason REQ-036 has a reason enum is that
-- *"find every cancellation someone made by mistake"* must be answerable with **one query**. A token buried in
-- a human sentence answers it with `LIKE '%ADMIN_ERROR%'` — which matches a note that merely mentions the
-- words, misses one typed in Thai, and quietly stops working the day someone rephrases the sentence. The
-- promise "we can clean this up later" is only real if later is a `WHERE`.
--
-- `note` keeps its job — the human sentence — and this keeps the machine one. Same three values as
-- `course_packages.end_reason` (`0023`), deliberately: a second vocabulary would split the very query this
-- exists to make possible.
--
-- Nullable and additive: every existing cancelled booking keeps `cancel_reason = NULL`, which is the honest
-- record (nobody asked those people for a reason) and is NOT back-filled with a guess.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate` — the snapshot chain stops
-- at 0003). Idempotent.

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "cancel_reason" text;
--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_cancel_reason_chk";
--> statement-breakpoint
-- A typo'd reason is a cancellation nobody can find again — the one job the enum has.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancel_reason_chk"
  CHECK ("cancel_reason" IS NULL OR "cancel_reason" IN ('PROGRAM_CHANGED', 'CUSTOMER_CANCELLED', 'ADMIN_ERROR'));
