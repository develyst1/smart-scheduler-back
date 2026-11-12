-- TASK-965 (REQ-5015, SPEC-108 §2) — COACH TIME RANGES: a PART-DAY leave (start_time/end_time on teacher_leave_days) and a coach's WORKING HOURS per weekday (teachers.work_hours).
-- ADDITIVE ONLY: nullable columns + a CHECK. Every existing leave row keeps NULL times = the WHOLE day = exactly today's behaviour (AC4); every teacher keeps NULL work_hours = no hours limit.
-- Hand-authored + journal-registered per drizzle/README.md (the snapshots stop at 0003 — do NOT run db:generate). Numbered 0080 = the 81st file.
-- Rerunnable: every column IF NOT EXISTS; the CHECK is DROP IF EXISTS + ADD. LOCKS: two nullable columns on a small table + one CHECK over (at most) a few hundred leave rows — no rewrite.
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST statement — `teachers.work_hours` — is invented by this file, so a run that died after the leave columns or the CHECK is not called applied.

ALTER TABLE "teacher_leave_days" ADD COLUMN IF NOT EXISTS "start_time" time;
--> statement-breakpoint
ALTER TABLE "teacher_leave_days" ADD COLUMN IF NOT EXISTS "end_time" time;
--> statement-breakpoint
ALTER TABLE "teacher_leave_days" DROP CONSTRAINT IF EXISTS "teacher_leave_days_time_ck";
--> statement-breakpoint
ALTER TABLE "teacher_leave_days" ADD CONSTRAINT "teacher_leave_days_time_ck" CHECK (("start_time" IS NULL AND "end_time" IS NULL) OR ("start_time" IS NOT NULL AND "end_time" IS NOT NULL AND "start_time" < "end_time"));
--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "work_hours" jsonb;
