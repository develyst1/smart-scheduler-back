-- SPEC-068 / TASK-217 — the DB stops holding the price card.
--
-- 🔴 What actually broke: `course_size_chk CHECK (size in (4, 6, 10))` has been on `course_packages` since
-- `0000`. TASK-213 taught the APP that an off-card size is importable when its leave quota is stated — and the
-- INSERT then hit this constraint, so Postgres threw and the API returned the generic 500
-- (`เกิดข้อผิดพลาดภายในระบบ`) that TASK-213 existed to eliminate. Same error, one layer down. Tanya found it on
-- `sid`: card size 201, off-card 500, preview green (it writes nothing).
--
-- **The app is the authority on which sizes may be sold or imported** — `decideImportSize` (4/6/10 outright,
-- anything else with an explicit quota) and `isCourseSize` on the SALE path, which is unchanged and still
-- refuses an off-card sale. What belongs in the database is a **sanity bound**, not the price card: the card
-- changes when the owner changes it, and a rule that lives in two places, one of which needs a migration to
-- move, is a rule that will be wrong in the place nobody can edit.
--
-- 1..100 matches the zod bound on the same field, so the two agree rather than one silently being narrower.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate` — the snapshot chain stops
-- at 0003). Idempotent, and safe on any existing row: every course today is 4, 6 or 10.

-- 🔴 The new constraint gets a NEW NAME on purpose. Replacing `course_size_chk` in place would leave the
-- migration **unwitnessable**: "does `course_size_chk` exist?" is true before and after, so a box where this
-- never ran would look identical to one where it did — and an unrunnable migration that looks applied is how
-- `0022` and the day-end job hid. `course_size_sanity_chk` exists only after 0027, so the probe is real.
ALTER TABLE "course_packages" DROP CONSTRAINT IF EXISTS "course_size_chk";
--> statement-breakpoint
ALTER TABLE "course_packages" DROP CONSTRAINT IF EXISTS "course_size_sanity_chk";
--> statement-breakpoint
ALTER TABLE "course_packages" ADD CONSTRAINT "course_size_sanity_chk"
  CHECK ("size" >= 1 AND "size" <= 100);
