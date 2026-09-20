-- TASK-420 (REQ-095 §13, SPEC-085 B) — DUO = ONE course, TWO kids: the course carries its second child
-- (`course_packages.co_student_id`) and its per-class coach rate (`class_rate_minor`, STORED — never posted); every row
-- the course plans copies the second child (`bookings.co_student_id`, written by the ONE inserter from the course) so
-- the reminder, the confirm / cancel / deduction notices, the check-in's CRM award and the family's LIFF reads see both
-- households without a join back to the course. A Private course has NULL in all three. Group (3–12) is untouched.
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 48 (0000–0047) and journal tags = 48 before this,
-- newest `0047`, so this is `0048` — the 49th file. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → … → `0047` → THIS — one `db:migrate` run; `db:verify` expects 49. No enum.
--
-- ⚠️ LOCKS, said plainly:
--   · `ALTER TABLE course_packages ADD COLUMN … NULL` ×2: a catalog blink on a small table (no default ⇒ no rewrite);
--     the FK takes SHARE ROW EXCLUSIVE on `students` for the blink.
--   · `ALTER TABLE bookings ADD COLUMN co_student_id … NULL REFERENCES students`: a catalog blink under ACCESS EXCLUSIVE
--     on `bookings` (no default ⇒ no rewrite) and SHARE ROW EXCLUSIVE on `students`.
--   · 🔴 `CREATE INDEX bookings_co_student_idx` on `bookings` — THE HOT TABLE — takes a **SHARE lock for its one scan:
--     reads continue, WRITES to `bookings` wait** until it finishes (sub-second at `uat`'s size; the partial predicate
--     means the index holds no rows yet). 🚫 Not `CONCURRENTLY`: it cannot run inside the migration's transaction (the
--     0033 trade). A booking write in that second waits, not fails.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `bookings_co_student_idx` — invented by this file, so a
-- run that died after the columns is not called applied. Rerunnable: every object IF NOT EXISTS.

-- The second child of a DUO course. RESTRICT: a child on a course is not deleted (the same rule as `student_id`).
ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "co_student_id" uuid NULL REFERENCES "students"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- The DUO course's per-class coach rate, in minor units — STORED at the sale (`duo.classRateMinor`), editable by
-- `PATCH /courses/:id` and by the session move; NEVER posted (the backoffice pass is the owner's pending decision).
ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "class_rate_minor" integer NULL;
--> statement-breakpoint

-- A planned row's second child — copied from the course by the ONE inserter (and by the two clones from their template),
-- so every per-row reader (reminder, notices, LIFF, CRM) sees both kids without the course. NULL on every other row.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "co_student_id" uuid NULL REFERENCES "students"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- The family's LIFF reads ("this household's rows" — `student_id IN … OR co_student_id IN …`) and the archive's
-- live-future count — partial, so it holds nothing for the thousands of Private rows.
CREATE INDEX IF NOT EXISTS "bookings_co_student_idx" ON "bookings" ("co_student_id") WHERE "co_student_id" IS NOT NULL;
