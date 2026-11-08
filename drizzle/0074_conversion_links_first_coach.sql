-- TASK-860 (REQ-120 F4) — the facts the Salary Bonus 50 / Bonus 100 lines read, STORED (they decide nothing): which 1st Trial a sale converted, the child's previous course / voucher, the first coach, the last whole-course
-- teacher change and the admin's Bonus-100 pick. ADDITIVE ONLY: nullable columns, no rename, no drop; NO DATA IS WRITTEN here (the links are written at the SALE, the first coach at the day-end job).
-- Hand-authored + journal-registered per drizzle/README.md (the snapshots stop at 0003 — do NOT run db:generate). Numbered 0074 = the 75th file; re-check against MIGRATION-QUEUE.md at apply time.
-- Rerunnable: every object IF NOT EXISTS, and each CHECK is DROP IF EXISTS + ADD. LOCKS: tiny tables, nullable columns with no default = a catalogue change, no rewrite.
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `voucher_from_trial_uq` — is invented by this file, so a run that died half-way is not called applied.

ALTER TABLE "course_packages"
  ADD COLUMN IF NOT EXISTS "from_trial_booking_id" uuid REFERENCES "bookings"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "prev_course_id" uuid REFERENCES "course_packages"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "prev_voucher_id" uuid REFERENCES "vouchers"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "first_teacher_id" uuid REFERENCES "teachers"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "coach_changed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "latest_teacher_id" uuid REFERENCES "teachers"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "bonus100_pick" text,
  ADD COLUMN IF NOT EXISTS "bonus100_pick_by" text,
  ADD COLUMN IF NOT EXISTS "bonus100_pick_at" timestamptz;
--> statement-breakpoint

ALTER TABLE "vouchers"
  ADD COLUMN IF NOT EXISTS "from_trial_booking_id" uuid REFERENCES "bookings"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "prev_course_id" uuid REFERENCES "course_packages"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "prev_voucher_id" uuid REFERENCES "vouchers"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "first_teacher_id" uuid REFERENCES "teachers"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- at most ONE previous entitlement, and the pick is a closed set
ALTER TABLE "course_packages" DROP CONSTRAINT IF EXISTS "course_prev_one_chk";
--> statement-breakpoint
ALTER TABLE "course_packages" ADD CONSTRAINT "course_prev_one_chk" CHECK ("prev_course_id" IS NULL OR "prev_voucher_id" IS NULL);
--> statement-breakpoint
ALTER TABLE "course_packages" DROP CONSTRAINT IF EXISTS "course_bonus100_pick_chk";
--> statement-breakpoint
ALTER TABLE "course_packages" ADD CONSTRAINT "course_bonus100_pick_chk" CHECK ("bonus100_pick" IS NULL OR "bonus100_pick" IN ('FIRST', 'LATEST', 'SHARE'));
--> statement-breakpoint
ALTER TABLE "vouchers" DROP CONSTRAINT IF EXISTS "voucher_prev_one_chk";
--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "voucher_prev_one_chk" CHECK ("prev_course_id" IS NULL OR "prev_voucher_id" IS NULL);
--> statement-breakpoint

-- one trial converts at most once PER TABLE (across the two tables the code enforces it, at the sale)
CREATE UNIQUE INDEX IF NOT EXISTS "course_from_trial_uq" ON "course_packages" ("from_trial_booking_id") WHERE "from_trial_booking_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "voucher_from_trial_uq" ON "vouchers" ("from_trial_booking_id") WHERE "from_trial_booking_id" IS NOT NULL;
