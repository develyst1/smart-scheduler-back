-- TASK-453 (REQ-105 §3/§8/§8.1, SPEC-091 §3+§5) — the GROUP slot YIELDS its coach-hour to a Private, and says so.
--
-- 🔑 THE FACT THIS FILE EXISTS FOR: `bookings_teacher_slot_uq` is a PARTIAL UNIQUE INDEX over exactly the slot-holding
-- rows, so **two holders of one coach-hour cannot be stored**. A visible clash therefore is not two rival bookings —
-- it is the GROUP row stepping aside and saying it did. `slot_yielded_at` is that step, and the index's own WHERE must
-- learn it in the SAME file: a partial index and its code mirror (`lib/slot-holder.ts`) are ONE fact in two places,
-- and this index has already drifted from its mirror once (SYSTEM-FACTS, TASK-397).
--
-- 🔴 THE THREE-WAY PIN: this file's WHERE, `schema.ts`'s `.where(sql`…`)` and `slotHolderWhere` rendered through
-- `PgDialect` are asserted EQUAL after normalisation by `src/lib/group-slot-yield-req105.test.ts`. Change one and the
-- suite fails naming the other two. (The TASK-439 `CHECK ⇔ END_REASONS` idea, applied to an index.)
--
-- `group_closed_at` rides along: an admin CLOSES a group series (no new dates, no enrolment) — existing rows untouched.
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 54 (0000–0053) and journal tags = 54 before this,
-- newest `0053`, so this is `0054` — the 55th file. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → … → `0053` → THIS — one `db:migrate` run; `db:verify` expects 55. No enum.
--
-- ⚠️ LOCKS — SAY IT PLAINLY (the `0045` standard): the two ADD COLUMNs are metadata-only (NULL default, no rewrite),
-- but the **DROP + CREATE of `bookings_teacher_slot_uq` takes ACCESS EXCLUSIVE on `bookings` — the hot table — for the
-- whole rebuild**, and every read and write of it waits. On this dataset (tens of thousands of rows) that is seconds,
-- not minutes; it is still a deploy-window statement, not a live one. 🚫 No CONCURRENTLY: it cannot run inside the
-- transaction `db:migrate` wraps each file in, and a half-built unique index would be worse than a short lock.
-- Rerunnable: IF NOT EXISTS on both columns, IF EXISTS on the drop, and the CREATE follows the drop.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the index's PREDICATE (`index-predicate`, contains `slot_yielded_at`).
-- 🚫 NOT the index's existence and NOT the column's: `bookings_teacher_slot_uq` exists before AND after (the 0007 /
-- 0033 / 0041 lesson — an existence probe is satisfied by the PREVIOUS version and reports this as applied on a box
-- where it never ran), and the column is added FIRST, so a column probe would pass on a half-applied file. The
-- predicate is the last thing this file does and the only thing that proves the whole of it.

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "slot_yielded_at" timestamptz NULL;
--> statement-breakpoint

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "group_closed_at" timestamptz NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "bookings_teacher_slot_uq";
--> statement-breakpoint

CREATE UNIQUE INDEX "bookings_teacher_slot_uq" ON "bookings" ("teacher_id", "date", "start_time")
WHERE "status" not in ('CANCELLED', 'PENDING_RESCHEDULE', 'SICK_LEAVE', 'PAUSED') and "group_id" is null and "slot_yielded_at" is null;
