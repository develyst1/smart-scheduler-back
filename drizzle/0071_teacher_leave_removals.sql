-- TASK-826 (REQ-125 ruling B, DESIGN §3) — what an ADVANCE leave took a teacher OFF, remembered so that Cancel leave can put them back.
-- When an advance leave (one day or a range) takes the leaving teacher off a co-taught class that runs on with the others, one row records it: which leave day, which class, whether they were the MAIN teacher, and their
-- stored rate for that class. Cancel leave reads these rows to put the teacher back (as an EXTRA teacher — D2) at that rate, then clears them; they also go with the leave day (ON DELETE CASCADE) or with the class
-- (ON DELETE CASCADE). `teacher_id` + `date` are kept on the row so a reader never has to join the leave table. A same-day leave records nothing (it cannot be lifted today).
-- NO DATA IS WRITTEN HERE. Rerunnable: YES — `CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS`. The unique index is the LAST object, so a half-applied file reads as «not applied» and re-runs (the witness rule).
CREATE TABLE IF NOT EXISTS "teacher_leave_removals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "leave_day_id" uuid NOT NULL REFERENCES "teacher_leave_days"("id") ON DELETE CASCADE,
  "booking_id" uuid NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE,
  "teacher_id" uuid NOT NULL REFERENCES "teachers"("id") ON DELETE RESTRICT,
  "date" date NOT NULL,
  "was_main" boolean NOT NULL,
  "rate_minor" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teacher_leave_removals_day_booking_uq" ON "teacher_leave_removals" ("leave_day_id", "booking_id");
