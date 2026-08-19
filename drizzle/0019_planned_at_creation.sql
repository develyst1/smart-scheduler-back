-- SPEC-049 / TASK-148 (REQ-045): mark an absence that was DECLARED WHEN THE COURSE WAS CREATED.
--
-- Owner decision B: a planned absence declared at creation is **free** (it does not consume leave quota); the
-- same action taken later still consumes it. Today nothing can tell those two apart — both are `SICK_LEAVE`
-- and the quota `+1` is unconditional. This is that missing distinction: a persisted birth-marker, deliberately
-- a FLAG rather than a new status value, so every existing status path (reconcile, holds, reports, the plan
-- engine) behaves exactly as before.
--
-- `NOT NULL DEFAULT false`: every existing row was, by definition, not declared at creation.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate` — see TASK-140).
-- Idempotent / re-runnable.

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "planned_at_creation" boolean NOT NULL DEFAULT false;
