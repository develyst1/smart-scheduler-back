-- TASK-488 — split the check-in provenance into a CHANNEL and a PERSON: `bookings.checkin_channel` / `checkin_actor` and
-- `camp_days.mark_channel` / `mark_actor`. 📌 Camp's pair is named for what it holds — ANY mark (a scan, a staff ABSENT, an
-- undo, the day-end cut), not only check-ins (Sober's ruling: a name that says one thing while the column holds another is the
-- very defect this file fixes).
--
-- 🔑 WHY: `bookings.checkin_source` (0056) and `camp_days.marked_by` each hold TWO kinds of fact in one column — a CHANNEL
-- (a closed set we choose: `checkin-qr` · `line` · `shopfront-qr` · `staff` · `end-of-day`) and, for a staff mark, a PERSON
-- (the admin's username, free text a human typed). Any rule written for one is wrong for the other: it put a parent one
-- default away from reading an admin's username (TASK-481) and made a free-text value a map key (TASK-482). They get a column
-- each: `checkin_channel` (the closed set, CHECKed below) and `checkin_actor` (free text, nullable).
--
-- 📌 `staff` is a channel this file adds to the four already written: a staff attend recorded only a username, so without it
-- a staff row would have an actor and no channel. The closed set is `CHECKIN_CHANNELS` in `lib/checkin-channel.ts` — the
-- CHECK below is pinned EQUAL to it (the TASK-439 shape).
--
-- 🔄 THE BACKFILL (the old values are not lost — the old columns are KEPT, see below):
--   · a value IN the channel set ⇒ `checkin_channel` = it, `checkin_actor` NULL;
--   · any OTHER non-null value ⇒ `checkin_actor` = it, `checkin_channel` = 'staff' — a username only ever came from the staff
--     path (`actorOf`), so that is the only channel it can have come through;
--   · NULL ⇒ both stay NULL.
--   Idempotent: every UPDATE fills only rows whose new columns are still NULL. The counts per value are what
--   `scripts/checkin-provenance-report.ts` prints (read-only) — run it before and after; the engineers never touch a database.
--
-- ⚠️ THE OLD COLUMNS ARE KEPT (`checkin_source`, `marked_by`) and are still written exactly as before. A dropped column is not
-- recoverable if this backfill mis-sorted anything, and a file ending in a DROP proves nothing on a re-run (0053). Proposed
-- drop: in its own migration, AFTER the owner has run the report on uat and the new columns carry everything (and after Undo,
-- which reads the pair, is live).
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 57 (0000-0056), journal tags = 57, newest `0056`, so this
-- is `0057` — the 58th file. Hand-authored + journal-registered per drizzle/README.md; do NOT run `db:generate`.
-- 📌 THE CUTOVER ORDER: `0038` -> ... -> `0056` -> THIS — one `db:migrate` run; `db:verify` expects 58. No enum.
-- ⚠️ LOCKS: the ADD COLUMNs are catalog-only (nullable, no default). The UPDATEs touch only rows that have a provenance (rows
-- attended since 0056, and camp days ever marked). Each CHECK is added NOT VALID then VALIDATEd (the 0045 shape: the scan runs
-- under SHARE UPDATE EXCLUSIVE, writes continue). Rerunnable: IF NOT EXISTS on the columns, DROP-IF-EXISTS before each CHECK.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object this file creates — `camp_days_mark_channel_chk`'s definition.
-- It is created after both backfills, so it cannot exist unless every statement before it ran (a column probe would pass on a
-- file that stopped after its first line).

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "checkin_channel" text;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "checkin_actor" text;
--> statement-breakpoint
ALTER TABLE "camp_days" ADD COLUMN IF NOT EXISTS "mark_channel" text;
--> statement-breakpoint
ALTER TABLE "camp_days" ADD COLUMN IF NOT EXISTS "mark_actor" text;
--> statement-breakpoint

-- the backfill — bookings
UPDATE "bookings" SET "checkin_channel" = "checkin_source"
  WHERE "checkin_channel" IS NULL AND "checkin_source" IN ('checkin-qr', 'line', 'shopfront-qr', 'staff', 'end-of-day');
--> statement-breakpoint
UPDATE "bookings" SET "checkin_channel" = 'staff', "checkin_actor" = "checkin_source"
  WHERE "checkin_channel" IS NULL AND "checkin_source" IS NOT NULL AND "checkin_source" NOT IN ('checkin-qr', 'line', 'shopfront-qr', 'staff', 'end-of-day');
--> statement-breakpoint

-- the backfill — camp days
UPDATE "camp_days" SET "mark_channel" = "marked_by"
  WHERE "mark_channel" IS NULL AND "marked_by" IN ('checkin-qr', 'line', 'shopfront-qr', 'staff', 'end-of-day');
--> statement-breakpoint
UPDATE "camp_days" SET "mark_channel" = 'staff', "mark_actor" = "marked_by"
  WHERE "mark_channel" IS NULL AND "marked_by" IS NOT NULL AND "marked_by" NOT IN ('checkin-qr', 'line', 'shopfront-qr', 'staff', 'end-of-day');
--> statement-breakpoint

-- the closed set, enforced by the database too — bookings, then camp days (LAST: the witness)
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_checkin_channel_chk";
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_checkin_channel_chk"
  CHECK ("checkin_channel" IN ('checkin-qr', 'line', 'shopfront-qr', 'staff', 'end-of-day')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_checkin_channel_chk";
--> statement-breakpoint
ALTER TABLE "camp_days" DROP CONSTRAINT IF EXISTS "camp_days_mark_channel_chk";
--> statement-breakpoint
ALTER TABLE "camp_days" ADD CONSTRAINT "camp_days_mark_channel_chk"
  CHECK ("mark_channel" IN ('checkin-qr', 'line', 'shopfront-qr', 'staff', 'end-of-day')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "camp_days" VALIDATE CONSTRAINT "camp_days_mark_channel_chk";
