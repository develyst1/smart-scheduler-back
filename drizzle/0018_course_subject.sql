-- SPEC-045 / TASK-140 (REQ-054): give a course a canonical program.
--
-- Until now a course's program was DERIVED from `bookings[0].subject` (`mappers.ts`, `coursesByIds`) — an
-- accident of row order. That is *why* both REQ-053 (per-session edit) and REQ-054 (mixed create) could
-- silently re-brand a whole course: there was no value to disagree with. This adds the value.
--
-- Back-fill is LOSSLESS: the owner-run DATA REQUEST (2026-08-16, via Porter) found **zero mixed-program
-- courses**, so every course's sessions agree and "the earliest session's subject" is the course's subject.
--
-- NOT NULL is applied CONDITIONALLY: a course with no bookings at all cannot be derived, and rather than fail
-- the deploy the column stays nullable in that case (readers keep the old derivation as a fallback). Expected
-- outcome on every real environment is NOT NULL; if it doesn't land, that is a signal to look, not a breakage.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate`). Idempotent / re-runnable.

ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "subject_id" uuid;
--> statement-breakpoint
ALTER TABLE "course_packages" DROP CONSTRAINT IF EXISTS "course_packages_subject_id_subjects_id_fk";
--> statement-breakpoint
ALTER TABLE "course_packages" ADD CONSTRAINT "course_packages_subject_id_subjects_id_fk"
  FOREIGN KEY ("subject_id") REFERENCES "subjects"("id");
--> statement-breakpoint
UPDATE "course_packages" c
   SET "subject_id" = (
     SELECT b."subject_id"
       FROM "bookings" b
      WHERE b."course_id" = c."id"
      ORDER BY b."date" ASC, b."start_time" ASC
      LIMIT 1
   )
 WHERE c."subject_id" IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "course_packages" WHERE "subject_id" IS NULL) THEN
    ALTER TABLE "course_packages" ALTER COLUMN "subject_id" SET NOT NULL;
  END IF;
END $$;
