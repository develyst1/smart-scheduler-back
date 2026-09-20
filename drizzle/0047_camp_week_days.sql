-- TASK-418 (REQ-095 §11, SPEC-085 A) — camp ON the teacher grid: the per-DAY object (`camp_week_days` — the teachers
-- and the window for one date of a week) and the link from a derived CAMP row (`bookings.camp_week_day_id`). The block
-- is REAL rows (`booking_type OTHER`, `other_kind CAMP`, CONFIRMED at birth) derived by ONE sync from the day object, so
-- the unique slot index, every availability read, the coach's reminder and the day-end all see the camp by
-- construction. The kids stay `camp_days` (0042) — untouched here.
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 47 (0000–0046) and journal tags = 47 before this,
-- newest `0046`, so this is `0047` — the 48th file. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → … → `0046` → THIS — one `db:migrate` run; `db:verify` expects 48. No enum.
--
-- ⚠️ LOCKS, said plainly:
--   · `CREATE TABLE camp_week_days` + its index: new objects, nothing waits.
--   · `ALTER TABLE camp_weeks ADD COLUMN … NULL` ×2: a catalog blink on a small table.
--   · `ALTER TABLE bookings ADD COLUMN camp_week_day_id … NULL REFERENCES camp_week_days`: a catalog blink under ACCESS
--     EXCLUSIVE on `bookings` (no default ⇒ no rewrite) and SHARE ROW EXCLUSIVE on the new, empty `camp_week_days`.
--   · 🔴 `CREATE INDEX bookings_camp_week_day_idx` on `bookings` — THE HOT TABLE — takes a **SHARE lock for its one scan:
--     reads continue, WRITES to `bookings` wait** until it finishes (sub-second at `uat`'s size; the partial predicate
--     means the index holds no rows yet). 🚫 Not `CONCURRENTLY`: it cannot run inside the migration's transaction (the
--     0033 trade). The cutover-minute rule does not apply, but a booking write in that second waits, not fails.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `bookings_camp_week_day_idx` — invented by this file, so
-- a run that died after the table or the columns is not called applied. Rerunnable: every object IF NOT EXISTS.

-- One row per (week, date): WHO holds the block that day and WHEN. Created for every date when a week is opened
-- (defaults: the week's teacher list, the week's window); edited per day (`PATCH /camp/weeks/:id/days/:date` — the
-- per-day swap), which stamps `edited_at` so a later week-level change re-derives only the days nobody touched.
-- `teacher_ids = '{}'` ⇒ no block that day (no rows). RESTRICT on the week: a week is closed, never deleted.
CREATE TABLE IF NOT EXISTS "camp_week_days" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "camp_week_id"  uuid NOT NULL REFERENCES "camp_weeks"("id") ON DELETE RESTRICT,
  "date"          date NOT NULL,
  "teacher_ids"   uuid[] NOT NULL DEFAULT '{}',
  "start_time"    time NOT NULL,
  "end_time"      time NOT NULL,
  "edited_at"     timestamptz NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "camp_week_days_week_date_uq" UNIQUE ("camp_week_id", "date")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "camp_week_days_week_idx" ON "camp_week_days" ("camp_week_id");
--> statement-breakpoint

-- The week's DEFAULT window (the owner's §12: one window per day, default 10:00–15:00, editable per week). NULL = the
-- code default (`CAMP_WINDOW_DEFAULT` in lib/camp.ts). A day row copies it at open; a later change re-derives the
-- un-edited days.
ALTER TABLE "camp_weeks" ADD COLUMN IF NOT EXISTS "window_start" time NULL;
--> statement-breakpoint

ALTER TABLE "camp_weeks" ADD COLUMN IF NOT EXISTS "window_end" time NULL;
--> statement-breakpoint

-- A DERIVED camp hour points at its day object. Set ⇒ the row is owned by the day (`409 CAMP_ROW_OWNED` on every human
-- write); NULL on every other booking. RESTRICT: the sync deletes the rows before a day row could ever go.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "camp_week_day_id" uuid NULL REFERENCES "camp_week_days"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- The sync's read ("the live CAMP rows of this day") — partial, so it holds nothing for the thousands of ordinary rows.
CREATE INDEX IF NOT EXISTS "bookings_camp_week_day_idx" ON "bookings" ("camp_week_day_id") WHERE "camp_week_day_id" IS NOT NULL;
