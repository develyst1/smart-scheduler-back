-- TASK-959 (REQ-5013 option B, SPEC-105 §2) — CLOSED DAYS: the whole school shut on a date. ADDITIVE ONLY: one NEW EMPTY table (no existing data is touched), a CHECK on the reason, and a partial unique index (at most one OPEN row per date).
-- Hand-authored + journal-registered per drizzle/README.md (the snapshots stop at 0003 — do NOT run db:generate). Numbered 0077 = the 78th file; re-check against MIGRATION-QUEUE.md at apply time (Team B's TASK-942 may also want 0077: whichever lands second renumbers, journal `when` stays unique).
-- Re-opening is SOFT (reopened_at / reopened_by), so the table is its own audit. Rerunnable: the table IF NOT EXISTS; the CHECK is DROP IF EXISTS + ADD; the index IF NOT EXISTS. LOCKS: a brand-new table, nothing to lock.
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `closed_days_open_date_uq` — is invented by this file, so a run that died after the table or the CHECK is not called applied.

CREATE TABLE IF NOT EXISTS "closed_days" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "date" date NOT NULL,
  "reason" text NOT NULL,
  "note" text,
  "range_id" uuid,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reopened_at" timestamp with time zone,
  "reopened_by" text
);
--> statement-breakpoint
ALTER TABLE "closed_days" DROP CONSTRAINT IF EXISTS "closed_days_reason_ck";
--> statement-breakpoint
ALTER TABLE "closed_days" ADD CONSTRAINT "closed_days_reason_ck" CHECK ("reason" IN ('HOLIDAY','VENUE_CLOSED','WEATHER','OTHER'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "closed_days_open_date_uq" ON "closed_days" ("date") WHERE "reopened_at" IS NULL;
