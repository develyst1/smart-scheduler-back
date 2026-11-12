-- TASK-961 (REQ-5014 option A, SPEC-106 §3) — the HISTORY of an activity change: a course's REMAINING classes (or one 1 HR / 1st Trial) moved from one activity (subject) to another, from the next class on.
-- One row per act; `course_id` XOR `booking_id`. It is also THE SEAM to the back office (Team C): its Detail row «X → Y» and the history note read these rows, so the COLUMN NAMES are the contract — renaming one is a SPEC change.
-- ADDITIVE ONLY: one NEW table + two indexes; no existing row or column is touched. Hand-authored + journal-registered per drizzle/README.md (the snapshots stop at 0003 — do NOT run db:generate).
-- Rerunnable: the table and both indexes are IF NOT EXISTS. LOCKS: a brand-new table takes no lock on anything that is read today (the two FKs take a brief SHARE ROW EXCLUSIVE on course_packages / bookings / subjects / teachers while they are added to the EMPTY table).
-- Numbered 0079 = the 80th file; TASK-942's 0078 and Team C's 0077 landed first — re-check against MIGRATION-QUEUE.md at apply time. The owner applies it on uat; on sid the queue applies it as usual.
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the table itself — it is this file's FIRST object and the others hang on it (the indexes cannot exist without it).

CREATE TABLE IF NOT EXISTS "activity_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "course_id" uuid REFERENCES "course_packages"("id") ON DELETE CASCADE,
  "booking_id" uuid REFERENCES "bookings"("id") ON DELETE CASCADE,
  "from_subject_id" uuid NOT NULL REFERENCES "subjects"("id"),
  "to_subject_id" uuid NOT NULL REFERENCES "subjects"("id"),
  "from_teacher_id" uuid REFERENCES "teachers"("id"),
  "to_teacher_id" uuid REFERENCES "teachers"("id"),
  "remaining" integer NOT NULL CHECK ("remaining" > 0),
  "size" integer NOT NULL CHECK ("size" > 0),
  "old_price_minor" integer NOT NULL,
  "new_price_minor" integer NOT NULL,
  "price_source" text NOT NULL CHECK ("price_source" IN ('CARD','MANUAL')),
  "difference_minor" integer NOT NULL CHECK ("difference_minor" >= 0),
  "revenue_relabelled" boolean NOT NULL DEFAULT false,
  "actor" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CHECK (("course_id" IS NULL) <> ("booking_id" IS NULL))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "activity_changes_course_idx" ON "activity_changes" ("course_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "activity_changes_booking_idx" ON "activity_changes" ("booking_id");
