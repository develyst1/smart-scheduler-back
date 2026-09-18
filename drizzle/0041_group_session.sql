-- TASK-397 (REQ-095 Stage 2a, SPEC-081) — the GROUP SESSION: a `GROUP` booking row HOLDS the teacher slot; the
-- children's course sessions are SEATS (`group_id` → the group row) that hold no slot of their own.
--
-- 🔴 Numbering: counted at the moment of writing, per the board rule ("no migration" is a CLAIM, not a state) —
-- `drizzle/*.sql` = 41 (0000–0040) and journal tags = 41 before this, newest `0040`, so this is `0041` — the
-- 42nd file. Hand-authored + journal-registered per drizzle/README.md; do NOT run `db:generate` (snapshots stop
-- at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → `0039` → `0040` → THIS — one `db:migrate` run applies them in journal order;
-- `db:verify` expects 42. None depends on another's objects.
--
-- 📌 WHY SEATS. `bookings_teacher_slot_uq` = ONE live booking per (teacher, date, start_time), mirrored by every
-- availability check. Two children's course sessions cannot both hold one slot — so the GROUP row holds it and
-- the children's sessions are seats OUTSIDE the index's predicate (`AND group_id IS NULL`). Everything a child's
-- session already has (check-in, deduction, the parent's LINE, leave, make-up) keeps working by construction;
-- the group row is the one live booking the invariant sees.
--
-- ⚠️ TRAP 1 (0029's) — `ALTER TYPE … ADD VALUE` and the value's first USE must not share a transaction.
-- `drizzle-kit migrate` runs the whole pending set inside ONE transaction, so NOTHING in this file references
-- `'GROUP'`: statement 4's predicate reads `group_id`, not the label; no backfill, no CHECK, no seed. The
-- preflight splits nothing today. 🔴 **`0042+` must never use `'GROUP'` in the same run as this file without
-- the preflight's split** — a migration that references the label sits in its own `db:migrate` run after this
-- one (the `0032`/`0033` shape).
--
-- 🔒 THE LOCK — read this before running it (the human runs it; it is why this comment exists):
--   · Statements 1–3 (the label, two nullable columns + an index on `group_id`): the label is a catalog write;
--     each `ADD COLUMN` takes ACCESS EXCLUSIVE on `bookings` for its statement, catalog-only (no rewrite);
--     `CREATE INDEX` on `group_id` takes SHARE on `bookings` (reads continue, writes wait) for one scan of the
--     table — small, every value NULL.
--   · 🔴 Statement 4 — `DROP INDEX` + `CREATE UNIQUE INDEX` take an **ACCESS EXCLUSIVE lock on `bookings` for the
--     REBUILD — writes AND reads block for its duration**, and the rebuild scans every row. `bookings` is the
--     HOT table (every calendar read, every availability check, the 17:30 job, the reminder, every booking
--     write). ⇒ **CLOSED SHOP: the quiet moment, never near 17:30, the morning reminder, or an import** — the
--     `0033` shape exactly. ⚠️ The queueing hazard: a transaction holding `bookings` when the DROP starts queues
--     the rebuild, and every calendar read queues behind the rebuild.
--   · 🚫 Deliberately NOT `CREATE INDEX CONCURRENTLY`: it cannot run inside a transaction, and every migration
--     here does. A brief total lock on a small table is the honest trade; a concurrent build would need this
--     file to leave the migration mechanism entirely.
--   · ONE run, ONE transaction, four statements (the DROP + CREATE are one logical step); columns and the new
--     index `IF NOT EXISTS`; the rebuild is idempotent by content.
--
-- ⚠️ WITNESS — the unique index's **PREDICATE**, never its existence. `bookings_teacher_slot_uq` exists before
-- and after; only its `WHERE` gains `AND group_id IS NULL`. An existence probe would be satisfied by `0033`'s
-- version and would call this applied on a box where it never ran — the `0022` blindness exactly.
--
-- 🚫 DELETING A GROUP ROW: `group_id` is `ON DELETE RESTRICT` — a group row with seats cannot vanish under them
-- (nothing deletes bookings today; the constraint is the backstop for the day something does).

ALTER TYPE "booking_type" ADD VALUE IF NOT EXISTS 'GROUP';
--> statement-breakpoint

-- The SERIES a group row belongs to (one uuid per `POST /bookings/group-series`; a course sold into the group
-- extends it under the same key). NULL on every non-group row.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "group_key" uuid NULL;
--> statement-breakpoint

-- A SEAT's group row (the GROUP booking of the same teacher/date/start). NULL = not a seat. Indexed: the cap
-- count and the seat reads hit it on every group write.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "group_id" uuid NULL REFERENCES "bookings"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_group_id_idx" ON "bookings" ("group_id");
--> statement-breakpoint

-- 🔴 The invariant, extended: seats are invisible to it. Same literal the application builds (`SLOT_INACTIVE_STATUSES`
-- + `lib/slot-holder.ts`), plus `group_id IS NULL`.
DROP INDEX "bookings_teacher_slot_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_teacher_slot_uq" ON "bookings" USING btree ("teacher_id","date","start_time") WHERE "bookings"."status" not in ('CANCELLED', 'PENDING_RESCHEDULE', 'SICK_LEAVE', 'PAUSED') AND "bookings"."group_id" IS NULL;
