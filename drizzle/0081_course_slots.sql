-- TASK-969 (REQ-5016 F1, SPEC-109 §2) — a course's WEEKLY PATTERN of hour-slots: only for courses with 2+ slots. ADDITIVE ONLY: one NEW EMPTY table, no existing data touched, NO backfill.
-- A course with no `course_slots` rows is a ONE-slot course and runs today's exact code paths (AC7): the branch everywhere is "rows >= 2".
-- Hand-authored + journal-registered per drizzle/README.md (the snapshots stop at 0003 — do NOT run db:generate). Numbered 0081 = the 82nd file.
-- Rerunnable: the table IF NOT EXISTS; the index IF NOT EXISTS. LOCKS: a brand-new table, nothing to lock.
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `course_slots_course_ord_uq` — is invented by this file, so a run that died after the table is not called applied.

CREATE TABLE IF NOT EXISTS "course_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "course_id" uuid NOT NULL REFERENCES "course_packages"("id") ON DELETE CASCADE,
  "ord" smallint NOT NULL,
  "weekday" smallint NOT NULL CHECK ("weekday" BETWEEN 0 AND 6),
  "start_time" time NOT NULL,
  "teacher_id" uuid NOT NULL REFERENCES "teachers"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "course_slots_course_ord_uq" ON "course_slots" ("course_id", "ord");
