-- SPEC-065 / TASK-198 — a course PAUSED (dropped) and later resumed: out of the schedule, not deleted, not
-- expired, and not ended.
--
-- 🔴 Why not reuse `ended_at`: dropping is **reversible** and ending is not. One column would make "the family
-- is coming back in March" and "the family stopped" the same fact, and every guard, badge and filter built on
-- it would then have to guess which one it was looking at. A course paused for two months would read CANCELLED
-- on the owner's screen, which is the exact class of lie REQ-036 B2 spent a task removing.
--
-- 🔴 Why not delete the sessions: "not deleted" is the promise the feature makes to the family. The rows are
-- soft-cancelled (CANCELLED), so the calendar is clear but the history — who was booked, when, with whom — is
-- still there when they come back and when someone asks why the slot went quiet.
--
-- No CHECK here, unlike `0023`: `drop_reason` is free text by design (a pause has no closed set of causes the
-- way an early ending does — "ไปต่างประเทศ 3 เดือน" is not an enum), so there is nothing to constrain.
--
-- All three nullable and additive: every existing course is untouched and behaves exactly as it does today.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate` — the snapshot chain stops
-- at 0003). Idempotent.

ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "dropped_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "dropped_by" text;
--> statement-breakpoint
ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "drop_reason" text;
