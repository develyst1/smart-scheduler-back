-- SPEC-060 / TASK-165 (REQ-064) — how many sessions of an imported course were already taught ELSEWHERE.
--
-- The defect this closes: an imported "bought 10, used 4" course stores `size = 10` but only ever holds the 6
-- remaining bookings (deliberately — inventing four past bookings would put fictional attendance in the reports).
-- The reconciler then measured that 6-row plan against `size = 10`, decided the course was four short, and
-- appended four phantom sessions on top of the real make-up — five free lessons, every time a parent took leave.
--
-- `prior_sessions` is the missing fact: the plan is responsible for `size − prior_sessions` sessions, while
-- `size` stays the PURCHASED size that quota, label and expiry are correctly built on.
--
-- 🔴 Why a new column rather than reusing `used_sessions`: `used_sessions` is a RUNNING count — it grows with
-- attendance. After the first attended session it can no longer be told apart from the import figure, and the
-- obvious fix (`size − used_sessions`) would then shrink a normal SALE course's target below its real bookings
-- and cancel a paying family's future sessions. `prior_sessions` is immutable and attendance-invariant, so the
-- SALE case is safe BY CONSTRUCTION: prior = 0 ⇒ planSize = size ⇒ exactly today's behaviour.
--
-- Default 0 means every SALE course — and every future one — is correct with no back-fill at all.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate` — the snapshot chain stops
-- at 0003). Idempotent.

ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "prior_sessions" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Back-fill the imports. `used_sessions` is the import figure for as long as nothing has been attended since,
-- which is true of a course whose only event has been a leave (a leave does not move `used_sessions`).
-- Guarded by `prior_sessions = 0` so a re-run cannot compound, and by `source = 'IMPORT'` so no SALE course is
-- ever touched.
--
-- ⚠️ Where a remaining session HAS been attended since the import, this over-states `prior_sessions` — the plan
-- would then believe it owes less than it does. That is the safe direction (it under-appends rather than giving
-- lessons away), it is NOT silently repaired here, and TASK-166 lists exactly those courses for the owner.
UPDATE "course_packages"
   SET "prior_sessions" = "used_sessions"
 WHERE "source" = 'IMPORT' AND "prior_sessions" = 0;
