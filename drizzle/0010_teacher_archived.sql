-- SPEC-004 / TASK-016: teacher soft-delete (offboarding) flag, distinct from `active` (pause).
-- Hand-written (matches the repo's IF-NOT-EXISTS migration style) because `drizzle-kit generate`
-- prompts a rename/create conflict against the drifted meta snapshot; IF NOT EXISTS makes it safe
-- to (re-)apply.
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "archived" boolean DEFAULT false NOT NULL;
