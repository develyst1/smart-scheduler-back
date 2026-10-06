-- TASK-690 (REQ-112, owner ruling 2026-10-06, LOCKED) — a new SESSION cancel reason, `SCHOOL_ISSUE` (TH `ปัญหาจากทางเรา`, EN
-- "A problem on our side"). It is the ONLY thing that carries REQ-112's trigger T3: a class the school cancels for its own reason
-- earns the course one more week. 🔴 `bookings.cancel_reason` is a CLOSED set in THREE places — the code set, the validator, and
-- THIS table's CHECK — and a code missing from the CHECK is a Postgres 23514 ⇒ a 500 on live (that is exactly what `0045` fixed for
-- `TEACHER_LEAVE`: an enum nobody listed a third copy of). So the code and this file land TOGETHER, and the suite pins the CHECK's
-- list ⇔ the code's session-reason set (a sixth code fails the suite until a migration carries it).
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 65 (0000–0064) and journal tags = 65 before this, newest `0064`,
-- so this is `0065` — the 66th file. ⚠️ The TASK named `0066`; there was no `0065` anywhere (tree, git, any branch) and its own
-- done-means ("66 .sql = 66 journal tags") only works out with `0065`, so a `0066` would have left a gap `db:verify` disagrees with.
-- Hand-authored + journal-registered per drizzle/README.md; do NOT run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0064` → THIS — one `db:migrate` run; `db:verify` expects 66. The OWNER runs it on deploy; nothing here ran.
--
-- ⚠️ SESSION cancel ONLY — deliberately NOT a reason to END A COURSE or a VOUCHER. Those have their own CHECKs and are UNTOUCHED:
--   · `course_packages_end_reason_chk` (0023) — three codes, unchanged;
--   · `vouchers_end_reason_chk` (0051) — four codes, unchanged.
-- "A problem on our side" is about ONE missed class, not ending a purchase. The code is valid for a session cancel, a group-date
-- cancel and the series cancel-all — and nothing else (the sibling set `SESSION_CANCEL_REASONS` in `lib/course-plan.ts`).
--
-- ⚠️ LOCKS — `bookings` is the HOT table, so this is said plainly (the 0045 honesty, unchanged):
--   · `DROP CONSTRAINT` and `ADD CONSTRAINT … NOT VALID`: ACCESS EXCLUSIVE on `bookings` for a catalog blink each — NO row scan
--     (`NOT VALID` skips validating existing rows; new writes are checked from this moment).
--   · `VALIDATE CONSTRAINT`: scans every row ONCE under SHARE UPDATE EXCLUSIVE — reads AND writes continue for the scan's duration.
--     Every existing value is one of 0045's four, a subset of the new five, so the scan cannot fail.
--   🚫 Deliberately NOT a single `ADD CONSTRAINT … CHECK`: that validates under the ACCESS EXCLUSIVE lock, blocking everything.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the constraint EXISTED before (0025, 0045), so existence proves nothing — the witness
-- is its DEFINITION (`pg_get_constraintdef` contains `SCHOOL_ISSUE`), the same shape as 0045. Rerunnable: DROP IF EXISTS + ADD,
-- then VALIDATE (a no-op on an already-valid constraint).
-- ⚠️ 0045's witness (`contains: TEACHER_LEAVE`) is NOT re-pointed: this definition still contains it, so it still reads applied —
-- and re-running 0045 would REGRESS this constraint to four codes, which is why it must keep reading applied. The same
-- precedent as 0025 → 0045 (a constraint-EXISTENCE witness survives a redefinition).

ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_cancel_reason_chk";
--> statement-breakpoint

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancel_reason_chk"
  CHECK ("cancel_reason" IS NULL OR "cancel_reason" IN ('PROGRAM_CHANGED', 'CUSTOMER_CANCELLED', 'ADMIN_ERROR', 'TEACHER_LEAVE', 'SCHOOL_ISSUE')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_cancel_reason_chk";
