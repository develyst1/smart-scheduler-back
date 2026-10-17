-- TASK-817 (REQ-123 Phase 1, P2) — an advance leave recorded as a DATE RANGE with one reason: one `teacher_leave_days` row per day (the gate and every reader stay per-day, untouched), all rows of one record
-- sharing a new nullable `range_id`, so the front can show and cancel "this leave" as one thing. NULL = a single-day record (every existing row, and every day recorded through the single-day door).
-- NO DATA IS WRITTEN HERE: existing rows keep NULL. Nothing is derived from consecutive dates + reason (fragile — Sober's design decision).
-- Rerunnable: YES — `ADD COLUMN IF NOT EXISTS`. `range_id` is the ONLY object the file adds, so a half-applied file reads as "not applied" and re-runs (the witness rule).
ALTER TABLE "teacher_leave_days" ADD COLUMN IF NOT EXISTS "range_id" uuid;
