-- TASK-443 (REQ-104 §2 items 4–5, SPEC-090 §2–§3) — two camp objects:
--   1. `camp_days.deduction_notified_at` — the DAY-END `camp_deduction` family notice's stamp (the owner's ruling: at day-end,
--      not at scan). A camp day scanned at 09:00 is ATTENDED long before the cut, so the day-end's second pass finds "every
--      CONSUMING day (ATTENDED | ABSENT — a no-show is charged, §8) dated on or before the run date and NOT yet stamped",
--      tells the family once, and stamps it in the same transaction. Idempotent by the stamp (no outbox key rides a tx).
--   2. `camp_week_day_rates` — the per-coach-per-day rate on the week's day editor (behind key 59): ONE row per coach per
--      day, the `booking_teachers` shape, `rate_minor` in satang. A coach with no row reads 0 (the new-day default is the
--      ABSENCE of a row); the ONE sync copies each coach's day rate onto the derived CAMP rows' `teacher_rate_minor`.
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 52 (0000–0051) and journal tags = 52 before this,
-- newest `0051`, so this is `0052` — the 53rd file. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → … → `0051` → THIS — one `db:migrate` run; `db:verify` expects 53. No enum.
--
-- ⚠️ LOCKS: `camp_days` is a small table — one nullable column, no default = a catalog-only ACCESS EXCLUSIVE blink, no
-- rewrite. `CREATE TABLE` touches nothing that exists. Rerunnable: IF NOT EXISTS on both.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the TABLE `camp_week_day_rates` — the LAST object this file creates.

ALTER TABLE "camp_days" ADD COLUMN IF NOT EXISTS "deduction_notified_at" timestamp with time zone;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "camp_week_day_rates" (
  "camp_week_day_id" uuid NOT NULL REFERENCES "camp_week_days"("id") ON DELETE CASCADE,
  "teacher_id"       uuid NOT NULL REFERENCES "teachers"("id") ON DELETE RESTRICT,
  "rate_minor"       integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("camp_week_day_id", "teacher_id")
);
