-- TASK-889 (REQ-120 F1, SPEC-099 §9) — the branch a course / voucher / booking was sold or held at: BRAVO | OTHER. ADDITIVE ONLY: three columns with a constant default (every existing row becomes BRAVO — true today, one branch) and three CHECKs. Nothing is dropped or renamed.
-- Hand-authored + journal-registered per drizzle/README.md (the snapshots stop at 0003 — do NOT run db:generate). Numbered 0076 = the 77th file; re-check against MIGRATION-QUEUE.md at apply time.
-- Rerunnable: each column IF NOT EXISTS; each CHECK is DROP IF EXISTS + ADD. LOCKS: Postgres 11+ adds a column with a constant default without rewriting the table (sid runs 18.4); the CHECK validates 2.8k bookings rows in a blink.
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `bookings_branch_ck` — is invented by this file, so a run that died half-way is not called applied.

ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "branch" text DEFAULT 'BRAVO' NOT NULL;
--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "branch" text DEFAULT 'BRAVO' NOT NULL;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "branch" text DEFAULT 'BRAVO' NOT NULL;
--> statement-breakpoint
ALTER TABLE "course_packages" DROP CONSTRAINT IF EXISTS "course_packages_branch_ck";
--> statement-breakpoint
ALTER TABLE "course_packages" ADD CONSTRAINT "course_packages_branch_ck" CHECK ("branch" IN ('BRAVO','OTHER'));
--> statement-breakpoint
ALTER TABLE "vouchers" DROP CONSTRAINT IF EXISTS "vouchers_branch_ck";
--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_branch_ck" CHECK ("branch" IN ('BRAVO','OTHER'));
--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_branch_ck";
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_branch_ck" CHECK ("branch" IN ('BRAVO','OTHER'));
