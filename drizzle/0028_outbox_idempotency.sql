-- TASK-218 — per-RECIPIENT idempotency for the 08:15 daily reminder.
--
-- 🔴 What broke: `runDailyReminderJob` suppressed a whole day on a job-level flag (`job_runs.summary.attempted`,
-- TASK-209). A manual/ops trigger at 07:00 set that flag, so the real 08:15 scheduled run skipped and **the
-- day's reminders were silently eaten** — a test trigger suppressing the morning send. Neither `sent` nor
-- `attempted` at the JOB level can be right: one re-runs all morning on a zero-reach day, the other eats the day.
--
-- The idempotency belongs at the **recipient**, exactly like the day-end sale's `rev:<bookingId>`
-- (`lib/sale-post.ts`): each person is keyed `reminder:<recipientType>:<personId>:<business-date>`, so the job
-- may run any number of times a day and each run sends only to people not already reminded.
--
-- Nullable BY DESIGN: every other outbox writer (confirms, leave, digests) has its own natural non-repeat and
-- passes no key — those rows stay NULL, and Postgres treats NULLs as distinct, so the unique index constrains
-- only the keyed rows. SKIPPED rows never carry a key either (see `lib/line.ts`): a person who was unlinked at
-- 07:00 and links LINE by 08:15 must still be reached, so an un-sendable row must not claim the key.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate` — the snapshot chain stops
-- at 0003). Idempotent, and safe on every existing row (they are all NULL).
ALTER TABLE "notification_outbox" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
-- The LAST object this migration creates — after the column it indexes — so a half-applied run is detectable,
-- and the index name exists only because 0028 ran (a real witness, per lib/migration-witness.ts rule 2).
CREATE UNIQUE INDEX IF NOT EXISTS "notification_outbox_idempotency_uq"
  ON "notification_outbox" ("idempotency_key");
