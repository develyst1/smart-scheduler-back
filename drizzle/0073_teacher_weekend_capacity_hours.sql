-- TASK-756 (REQ-5004) — Coach Capacity: a PART_TIME coach's weekend capacity is the type's rate (6 h per weekend day worked) unless the coach has his own value. ONE nullable column on `teachers`: NULL = the type's rate.
-- NO DATA IS WRITTEN HERE and no coach is named: setting one coach's value is a DATA REQUEST (one UPDATE per environment, run by the owner).
-- Rerunnable: YES — `ADD COLUMN IF NOT EXISTS`. `weekend_capacity_hours` is the ONLY object the file adds, so a half-applied file reads as "not applied" and re-runs (the witness rule).
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "weekend_capacity_hours" smallint;
