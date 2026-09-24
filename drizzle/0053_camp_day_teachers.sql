-- TASK-454 (REQ-105 §1, SPEC-091 §1) — a camp day's coaches each get their OWN window: coach A 10–12 while coach B
-- works 13–15. Until now a DAY had one window and an array of coaches, so every coach on it worked the same hours.
--
-- 🔑 ONE table, not two. TASK-443's `camp_week_day_rates` has the SAME primary key as the per-coach hours would and
-- is read for the same rows every time — two identically-keyed tables can disagree about who is on the day, and then
-- something has to decide which one wins. That is the blinding shape TASK-449 removed from the LINE link path; it is
-- not going in here. So the hours and the rate live on ONE row per (day, coach).
--
-- ⚠️ NULL hours mean **the day's default** and are resolved at READ, never copied down: a day-level window change must
-- reach every coach who never asked for their own hours, which is what a default is for. Copying would freeze each
-- coach at the value of the day they happened to be added.
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 53 (0000–0052) and journal tags = 53 before this,
-- newest `0052`, so this is `0053` — the 54th file. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → … → `0052` → THIS — one `db:migrate` run; `db:verify` expects 54. No enum.
--
-- ⚠️ LOCKS — all three tables are SMALL: `CREATE TABLE` touches nothing that exists; the backfill is one INSERT …
-- SELECT over `camp_week_days`; the two DROPs take ACCESS EXCLUSIVE for a catalog blink each. Rerunnable: IF NOT
-- EXISTS on the table, `ON CONFLICT DO NOTHING` on the backfill, IF EXISTS on both drops.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the TABLE `camp_week_day_teachers`. The last statement is a DROP, and a
-- DROP proves nothing on a re-run — so the witness is the thing this file CREATES, as `0052`'s was.
--
-- 🚫 `camp_weeks.teacher_ids` is UNTOUCHED: that column is the week's roster (the default for a new day, and the
-- "my weeks" scope filter in `scheduler.service.ts`). Only the DAY's array goes.

CREATE TABLE IF NOT EXISTS "camp_week_day_teachers" (
  "camp_week_day_id" uuid NOT NULL REFERENCES "camp_week_days"("id") ON DELETE CASCADE,
  "teacher_id"       uuid NOT NULL REFERENCES "teachers"("id") ON DELETE RESTRICT,
  "start_time"       time NULL,
  "end_time"         time NULL,
  "rate_minor"       integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("camp_week_day_id", "teacher_id")
);
--> statement-breakpoint

-- Every coach already on a day keeps that day's window (NULL = the default) and whatever rate TASK-443 stored for
-- them (LEFT JOIN: "no rate set yet" is 0, the same number `dayRatesOf` already returned by absence).
INSERT INTO "camp_week_day_teachers" ("camp_week_day_id", "teacher_id", "start_time", "end_time", "rate_minor")
SELECT d."id", t."teacher_id", NULL, NULL, COALESCE(r."rate_minor", 0)
FROM "camp_week_days" d
CROSS JOIN LATERAL unnest(d."teacher_ids") AS t("teacher_id")
LEFT JOIN "camp_week_day_rates" r ON r."camp_week_day_id" = d."id" AND r."teacher_id" = t."teacher_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint

DROP TABLE IF EXISTS "camp_week_day_rates";
--> statement-breakpoint

ALTER TABLE "camp_week_days" DROP COLUMN IF EXISTS "teacher_ids";
