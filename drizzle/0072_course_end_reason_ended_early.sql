-- TASK-837 (REQ-126 "ตัดจบคอร์ส") — a 4th code on a COURSE's end reason: `ENDED_EARLY` (TH `ตัดจบคอร์ส`, EN "Course ended early"). `course_packages.end_reason` is a CLOSED set in THREE places — the
-- code set (`COURSE_END_REASONS`, lib/course-plan.ts), the door in `endCourse`, and THIS table's CHECK — and a code missing from the CHECK is a Postgres 23514 ⇒ a 500 on live. So the code and this file land TOGETHER,
-- and the suite pins the CHECK's list ⇔ the code's course set.
--
-- The list is EXACTLY `PROGRAM_CHANGED, CUSTOMER_CANCELLED, ADMIN_ERROR, ENDED_EARLY`: 0023's three + the new one. `TEACHER_LEAVE` is deliberately NOT here — it is written by a teacher's own leave on ROWS and is not a reason to
-- end a course; `endCourse` refuses it at its door with a 400 `INVALID_REASON` (never a 500). The VOUCHER's CHECK (`vouchers_end_reason_chk`, 0051) is UNTOUCHED: the voucher end does not accept this code.
--
-- Numbering: `drizzle/*.sql` = 72 (0000–0071) and journal tags = 72 before this, newest `0071`, so this is `0072` — the 73rd file. Hand-authored + journal-registered per drizzle/README.md; do NOT run `db:generate`.
-- NO DATA IS WRITTEN. Rerunnable: DROP CONSTRAINT IF EXISTS + ADD … NOT VALID, then VALIDATE (a no-op on an already-valid constraint).
-- LOCKS: `course_packages` is small; `NOT VALID` skips the scan under the ACCESS EXCLUSIVE blink and `VALIDATE` scans once under SHARE UPDATE EXCLUSIVE (every existing value is one of 0023's three, a subset of the new four,
-- so it cannot fail). 🔑 THE WITNESS (`lib/migration-witness.ts`): the constraint EXISTED before (0023), so existence proves nothing — the witness is its DEFINITION (`pg_get_constraintdef` contains `ENDED_EARLY`), the 0045 shape.
-- ⚠️ 0023's witness (constraint EXISTS) is NOT re-pointed: this definition still satisfies it, and re-running 0023 would REGRESS the CHECK to three codes, which is why it must keep reading applied.

ALTER TABLE "course_packages" DROP CONSTRAINT IF EXISTS "course_packages_end_reason_chk";
--> statement-breakpoint

ALTER TABLE "course_packages" ADD CONSTRAINT "course_packages_end_reason_chk"
  CHECK ("end_reason" IS NULL OR "end_reason" IN ('PROGRAM_CHANGED', 'CUSTOMER_CANCELLED', 'ADMIN_ERROR', 'ENDED_EARLY')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "course_packages" VALIDATE CONSTRAINT "course_packages_end_reason_chk";
