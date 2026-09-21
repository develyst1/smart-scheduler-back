-- TASK-428 (REQ-101, SPEC-088 Part A) — the OTHER SERIES key: an ECA/Free/KOL schedule is N independent `OTHER` rows
-- (one per date) and nothing tied them together after creation. `bookings.other_series_key` (the `group_key` shape) is
-- minted ONCE by the series creator and stamped on every row, so the Manage-plan page can list, confirm-all, cancel-all,
-- add/remove/swap a teacher and add dates by key. Existing rows have NULL until the one-off backfill
-- (`scripts/backfill-other-series.ts`) runs. CAMP rows never get one (they belong to `camp_week_days`).
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 49 (0000–0048) and journal tags = 49 before this,
-- newest `0048`, so this is `0049` — the 50th file. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → … → `0048` → THIS — one `db:migrate` run; `db:verify` expects 50. No enum. Then the
-- human runs `bun scripts/backfill-other-series.ts --dry-run`, reads the groups, and `--apply`.
--
-- ⚠️ LOCKS, said plainly:
--   · `ALTER TABLE bookings ADD COLUMN other_series_key uuid NULL`: a catalog blink under ACCESS EXCLUSIVE on `bookings`
--     (no default ⇒ no rewrite).
--   · 🔴 `CREATE INDEX bookings_other_series_idx` on `bookings` — THE HOT TABLE — takes a **SHARE lock for its one scan:
--     reads continue, WRITES to `bookings` wait** until it finishes (sub-second at `uat`'s size; the partial predicate
--     means the index holds no rows yet). 🚫 Not `CONCURRENTLY`: it cannot run inside the migration's transaction (the
--     0033 trade). A booking write in that second waits, not fails.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `bookings_other_series_idx` — invented by this file, so a
-- run that died after the column is not called applied. Rerunnable: every object IF NOT EXISTS.

-- The series an OTHER row belongs to; NULL on every other type and on un-backfilled rows.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "other_series_key" uuid NULL;
--> statement-breakpoint

-- The Manage-plan reads ("the rows of this series") — partial, so it holds nothing for the thousands of lesson rows.
CREATE INDEX IF NOT EXISTS "bookings_other_series_idx" ON "bookings" ("other_series_key") WHERE "other_series_key" IS NOT NULL;
