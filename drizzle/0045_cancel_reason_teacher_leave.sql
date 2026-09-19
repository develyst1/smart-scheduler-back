-- TASK-410 (REQ-097) — 🔴 the teacher-leave 500: `0025`'s CHECK on `bookings.cancel_reason` knows three codes; TASK-406
-- added `TEACHER_LEAVE` to `END_REASONS` and the validator, and `reportOwnLeave` wrote it ⇒ Postgres 23514 ⇒ 500, the
-- tx rolled back (Tanya, REQ-097 check 2). The DB's closed set was a THIRD copy nobody listed. This file redefines the
-- CHECK with the fourth code; the suite now pins the CHECK's list ⇔ `END_REASONS` (a fifth code fails the suite until a
-- migration carries it).
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 45 (0000–0044) and journal tags = 45 before this,
-- newest `0044`, so this is `0045` — the 46th file. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → … → `0044` → THIS — one `db:migrate` run; `db:verify` expects 46.
--
-- ⚠️ LOCKS — `bookings` is the HOT table, so this is said plainly (the 0033 honesty):
--   · `DROP CONSTRAINT` and `ADD CONSTRAINT … NOT VALID`: ACCESS EXCLUSIVE on `bookings` for a catalog blink each — NO
--     row scan (`NOT VALID` skips validating existing rows; new writes are checked from this moment).
--   · `VALIDATE CONSTRAINT`: scans every row ONCE under SHARE UPDATE EXCLUSIVE — reads AND writes continue for the
--     scan's duration (seconds on `uat`'s size). Every existing value is one of 0025's three, so the scan cannot fail.
--   🚫 Deliberately NOT a single `ADD CONSTRAINT … CHECK`: that validates under the ACCESS EXCLUSIVE lock, blocking
--     everything for the scan.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the constraint EXISTED before (0025), so existence proves nothing — the
-- witness is its DEFINITION (`pg_get_constraintdef` contains `TEACHER_LEAVE`), the index-predicate shape (0007).
-- Rerunnable: DROP IF EXISTS + ADD, then VALIDATE (a no-op on an already-valid constraint).

ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_cancel_reason_chk";
--> statement-breakpoint

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancel_reason_chk"
  CHECK ("cancel_reason" IS NULL OR "cancel_reason" IN ('PROGRAM_CHANGED', 'CUSTOMER_CANCELLED', 'ADMIN_ERROR', 'TEACHER_LEAVE')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_cancel_reason_chk";
