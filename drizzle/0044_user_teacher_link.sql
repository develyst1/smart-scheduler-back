-- TASK-406 (REQ-097, SPEC-083 §1.1) — the user ↔ teacher LINK: `users.teacher_id`, one user per teacher, one
-- teacher per user. A user WITH a link is SCOPED to their own calendar by construction (`lib/own-scope.ts`); a user
-- without one is today's admin, untouched. ONE nullable column + ONE partial unique index. Nothing else.
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 44 (0000–0043) and journal tags = 44 before this,
-- newest `0043`, so this is `0044` — the 45th file. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → … → `0043` → THIS — one `db:migrate` run applies them in journal order; `db:verify`
-- expects 45. 🚫 No enum, no `'GROUP'`, no `bookings`.
--
-- ⚠️ Locks — catalog-only:
--   · `ALTER TABLE users ADD COLUMN … NULL REFERENCES teachers`: a catalog write on `users` (tiny — the staff accounts)
--     and, for the FK, **SHARE ROW EXCLUSIVE on `teachers`** for its duration — reads continue, concurrent writes to
--     `teachers` wait for the blink (the 0035 / 0042 shape). No rewrite (no default). No lock on any hot table
--     (`bookings` untouched).
--   · The partial unique index builds on `users` in the same blink.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `users_teacher_id_uq` — invented by this file, so a
-- run that died after the column is not called applied. Rerunnable: every object IF NOT EXISTS.

-- NULL = an unscoped admin (every account today). Set by the super admin on the Users page (a teacher picker).
-- RESTRICT: a linked teacher cannot be deleted from under their account — unlink first (the users page), or archive
-- the teacher (`active = false`), which leaves the link.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "teacher_id" uuid NULL REFERENCES "teachers"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- One user per teacher. The service answers `409 TEACHER_LINKED` first; this is the backstop under a race.
CREATE UNIQUE INDEX IF NOT EXISTS "users_teacher_id_uq" ON "users" ("teacher_id") WHERE "teacher_id" IS NOT NULL;
