-- TASK-942 (REQ-120 F5 follow-up; SPEC: several park groups in the SAME hour) — a PARK-FEE block (an OTHER booking on the one system teacher "No Teacher", TASK-861) no longer holds a coach-hour: several groups may rent the park at once
-- (ขวัญ «พร้อมกันหลายกรุ้ปได้นะคะ», confirmed by the owner via Porter 2026-11-10; supersedes DECISIONS row 11's "one park block per hour"). A REAL teacher still cannot be double-booked.
--
-- 🔑 THE FACT THIS FILE EXISTS FOR: `bookings_teacher_slot_uq` is a PARTIAL UNIQUE INDEX over exactly the slot-holding rows. Its WHERE gains ONE term, `AND NOT slot_exempt`; a row is exempt ONLY when the code stamped it on the system
-- teacher (`insertBooking`, from the teacher ROW's flag — never from a request field). The partial index and its code mirror (`lib/slot-holder.ts`) stay ONE fact in two places: the three spellings (this file's WHERE · `schema.ts`'s `.where(sql…)` ·
-- `slotHolderWhere` rendered) are asserted EQUAL by `group-slot-yield-req105.test.ts`, which now reads THIS file.
--
-- ADDITIVE: one column with a constant default (no table rewrite), one idempotent backfill (the existing park blocks), the index rebuilt with the one extra clause (its current text copied from 0054 — nothing else changes).
-- ⚠️ LOCK: DROP + CREATE UNIQUE INDEX on `bookings` takes ACCESS EXCLUSIVE for the build (the table is hot: every calendar read waits). No CONCURRENTLY — a DROP and a CREATE cannot share one transaction with it, and a window with NO unique index
-- would let a double-booking in. The owner applies it at a quiet time; on sid the queue applies it as usual.
-- Hand-authored + journal-registered per drizzle/README.md (the snapshots stop at 0003 — do NOT run db:generate). Rerunnable: the column IF NOT EXISTS; the UPDATE sets the same value; DROP IF EXISTS then CREATE.
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the index PREDICATE contains `slot_exempt` — NOT the index's existence (it exists before AND after), and NOT the column (added first).

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "slot_exempt" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

UPDATE "bookings" SET "slot_exempt" = true WHERE "teacher_id" IN (SELECT "id" FROM "teachers" WHERE "is_system") AND NOT "slot_exempt";
--> statement-breakpoint

DROP INDEX IF EXISTS "bookings_teacher_slot_uq";
--> statement-breakpoint

CREATE UNIQUE INDEX "bookings_teacher_slot_uq" ON "bookings" ("teacher_id", "date", "start_time")
WHERE "status" not in ('CANCELLED', 'PENDING_RESCHEDULE', 'SICK_LEAVE', 'PAUSED') and "group_id" is null and "slot_yielded_at" is null and not "slot_exempt";
