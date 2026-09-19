-- TASK-401 (REQ-095 Stage 3a, SPEC-082) — "Balance camp": the DAY entitlement. Three NEW tables: `camp_weeks` (the
-- admin-opened container), `camp_packages` (a child's prepaid units — NO expiry, by structure), `camp_days` (one row
-- per child per date).
--
-- 🔴 Numbering: counted at the moment of writing, per the board rule ("no migration" is a CLAIM, not a state) —
-- `drizzle/*.sql` = 42 (0000–0041) and journal tags = 42 before this, newest `0041`, so this is `0042` — the
-- 43rd file. Hand-authored + journal-registered per drizzle/README.md; do NOT run `db:generate` (snapshots stop
-- at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → `0039` → `0040` → `0041` → THIS — one `db:migrate` run applies them in journal
-- order; `db:verify` expects 43. 🚫 Nothing here references `'GROUP'` (0041's TRAP 1 sentence): no enum at all.
--
-- 📌 THE MODEL (SPEC-082 §1, the owner's rulings §8). Nothing in the schema is a DAY: courses are hour sessions with
-- a quota and an expiry; vouchers are hour buckets. A camp is a PREPAID bucket of half-day UNITS (a full day = 2,
-- a half = 1 — integers, one currency) that a child spends on dates inside admin-opened WEEKS, cut BY DAY.
-- **There is no expiry column — deliberately.** The owner's rule ("unused days become a credit, no expiry") is
-- made structural: nothing can later add one without a migration, which is the point. Every status / kind /
-- plan / half is a TEXT code list (`lib/camp.ts`), never a Postgres enum — nothing to split, ever.
--
-- 🔒 THE LOCK — read this before running it (the human runs it; it is why this comment exists):
--   · Three NEW tables and three NEW indexes. The only FK to an EXISTING table is `camp_packages.student_id →
--     students`: that statement takes **SHARE ROW EXCLUSIVE on `students`** for its duration — reads continue,
--     WRITES to `students` wait; the new table is empty, so there is no validation scan: milliseconds (the `0035`
--     shape). The other FKs point at tables this file creates. **No lock on any hot table** (`bookings` untouched).
--   · ONE run, ONE transaction, seven statements; every object `IF NOT EXISTS` ⇒ rerunnable.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `camp_days_package_date_uq` — a unique index invented
-- by this migration over a table invented by this migration (0034's two rules). Witnessing a table would call a
-- run that died mid-way "applied", and the one-day-per-child-per-date guarantee would never exist.

-- The admin-opened container. "Week" is the owner's word: 1–7 consecutive dates. `capacity` per DATE, NULL = unlimited.
-- `teacher_ids` is INFORMATIONAL (§8: no slot block in 3a). `status`: OPEN | CLOSED (CLOSED ⇒ no new planning).
CREATE TABLE IF NOT EXISTS "camp_weeks" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"         text NOT NULL,
  "start_date"   date NOT NULL,
  "end_date"     date NOT NULL,
  "capacity"     integer,
  "teacher_ids"  uuid[],
  "status"       text NOT NULL DEFAULT 'OPEN',
  "opened_by"    text,
  "opened_at"    timestamptz NOT NULL DEFAULT now(),
  "closed_at"    timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "camp_weeks_dates_idx" ON "camp_weeks" ("start_date", "end_date");
--> statement-breakpoint

-- A child's prepaid UNITS (the sale). `kind`: FULL | HALF · `plan`: FULL_WEEK | DAILY · `total_units` = days × (FULL 2 |
-- HALF 1) · `used_units` grows as days are ATTENDED / ABSENT (both consume — §8). The discount columns are the
-- booking's four (TASK-160's shape): early bird is a DISCOUNT with a reason, never a product. 🚫 NO expiry column.
CREATE TABLE IF NOT EXISTS "camp_packages" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "student_id"       uuid NOT NULL REFERENCES "students"("id") ON DELETE RESTRICT,
  "kind"             text NOT NULL,
  "plan"             text NOT NULL,
  "total_units"      integer NOT NULL,
  "used_units"       integer NOT NULL DEFAULT 0,
  "sale_id"          text,
  "discount_kind"    text,
  "discount_value"   integer,
  "discount_reason"  text,
  "discount_actor"   text,
  "note"             text,
  "created_by"       text,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "camp_packages_student_idx" ON "camp_packages" ("student_id");
--> statement-breakpoint

-- One row per child per date. `half`: AM | PM | FULL · `units`: copied at planning (2 | 1) · `status`: PLANNED (reserves)
-- | ATTENDED (consumed) | ABSENT (consumed — a no-show is charged, §8) | CANCELLED (released; only before the day).
CREATE TABLE IF NOT EXISTS "camp_days" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "camp_package_id"   uuid NOT NULL REFERENCES "camp_packages"("id") ON DELETE RESTRICT,
  "camp_week_id"      uuid NOT NULL REFERENCES "camp_weeks"("id") ON DELETE RESTRICT,
  "date"              date NOT NULL,
  "half"              text NOT NULL,
  "units"             integer NOT NULL,
  "status"            text NOT NULL DEFAULT 'PLANNED',
  "marked_by"         text,
  "marked_at"         timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "camp_days_week_date_idx" ON "camp_days" ("camp_week_id", "date");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "camp_days_package_date_uq" ON "camp_days" ("camp_package_id", "date");
