-- TASK-439 (REQ-103, SPEC-089 B) — a WHOLE voucher can be cancelled on the course-end shape: `vouchers.ended_at / ended_by /
-- end_reason`. The end freezes the FUTURE (every live draw dated today or later is soft-cancelled, no new draw may be made) and
-- never the past (`used_hours` untouched, an attended hour stays attended, its undo still returns the hour). The reason is the
-- SAME closed set a course end uses — `END_REASONS` in `lib/course-plan.ts` — so the CHECK below is its database copy, pinned
-- equal by the suite (the 0045 lesson: a third copy nobody listed).
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 51 (0000–0050) and journal tags = 51 before this,
-- newest `0050`, so this is `0051` — the 52nd file. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → … → `0050` → THIS — one `db:migrate` run; `db:verify` expects 52. No enum.
--
-- ⚠️ LOCKS — `vouchers` is a SMALL table: three nullable columns with no default = a catalog-only ACCESS EXCLUSIVE blink each,
-- no rewrite. The CHECK is added `NOT VALID` (catalog only) then `VALIDATE`d under SHARE UPDATE EXCLUSIVE — every existing row
-- has `end_reason IS NULL`, so the scan cannot fail. Rerunnable: IF NOT EXISTS on the columns, DROP IF EXISTS + ADD on the CHECK.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the CHECK's DEFINITION (`pg_get_constraintdef` contains `TEACHER_LEAVE`) — the
-- LAST object this file creates, the 0045 shape.

ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "ended_by" text;
--> statement-breakpoint

ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "end_reason" text;
--> statement-breakpoint

ALTER TABLE "vouchers" DROP CONSTRAINT IF EXISTS "vouchers_end_reason_chk";
--> statement-breakpoint

ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_end_reason_chk"
  CHECK ("end_reason" IS NULL OR "end_reason" IN ('PROGRAM_CHANGED', 'CUSTOMER_CANCELLED', 'ADMIN_ERROR', 'TEACHER_LEAVE')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "vouchers" VALIDATE CONSTRAINT "vouchers_end_reason_chk";
