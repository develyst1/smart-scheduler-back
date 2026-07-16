-- Auto-cut end-of-day (UC-012): NO_SHOW booking status + job_runs audit log.
-- A confirmed class that ends with no check-in and no leave becomes NO_SHOW and
-- its course/voucher quota is cut. job_runs records each end-of-day sweep so ops
-- can confirm the Windows Task Scheduler trigger fired.
ALTER TYPE "public"."booking_status" ADD VALUE IF NOT EXISTS 'NO_SHOW';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"run_date" date NOT NULL,
	"status" text DEFAULT 'success' NOT NULL,
	"summary" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_runs_job_date_idx" ON "job_runs" ("job","run_date");
